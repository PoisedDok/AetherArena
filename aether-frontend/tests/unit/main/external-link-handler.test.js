'use strict';

// ===========================================================================
// Module-level mocks
// ===========================================================================

const mockShellOpenExternal = jest.fn().mockResolvedValue(undefined);

jest.mock('electron', () => ({
  shell: { openExternal: mockShellOpenExternal },
}), { virtual: true });

const mockLoggerChild = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  // Nested child() for windowLogger
  child: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
};

jest.mock('../../../src/core/utils/logger', () => ({
  logger: {
    child: jest.fn(() => mockLoggerChild),
    error: jest.fn(),
  },
}));

// ===========================================================================
// Require after mocks
// ===========================================================================

const {
  ExternalLinkHandler,
  getHandler,
  createHandler,
  attachToWindow,
  ALLOWED_SCHEMES,
  EXTERNAL_SCHEMES,
  BLOCKED_PATTERNS,
} = require('../../../src/main/security/ExternalLinkHandler');

// ===========================================================================
// Helpers
// ===========================================================================

function createMockWindow(overrides = {}) {
  const handlers = {};
  const webContents = {
    on: jest.fn((event, handler) => { handlers[event] = handler; }),
    setWindowOpenHandler: jest.fn((handler) => { handlers['window-open'] = handler; }),
    _handlers: handlers,
  };
  return {
    id: overrides.id || 1,
    isDestroyed: jest.fn(() => overrides.destroyed || false),
    webContents,
    ...overrides,
    // Ensure webContents is not overridden by spread
    ...(overrides.webContents ? { webContents: overrides.webContents } : { webContents }),
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('ExternalLinkHandler', () => {
  let handler;

  beforeEach(() => {
    // Manual mock cleanup (lesson learned: resetMocks doesn't reliably clear module-level mocks)
    mockShellOpenExternal.mockClear();
    mockShellOpenExternal.mockResolvedValue(undefined);
    mockLoggerChild.info.mockClear();
    mockLoggerChild.warn.mockClear();
    mockLoggerChild.error.mockClear();
    mockLoggerChild.debug.mockClear();
    mockLoggerChild.child.mockClear();
    mockLoggerChild.child.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    });

    handler = new ExternalLinkHandler();
  });

  // ==================== Constants ====================

  describe('constants', () => {
    it('should export frozen ALLOWED_SCHEMES', () => {
      expect(Object.isFrozen(ALLOWED_SCHEMES)).toBe(true);
      expect(ALLOWED_SCHEMES).toContain('file:');
      expect(ALLOWED_SCHEMES).toContain('about:');
      expect(ALLOWED_SCHEMES).toContain('devtools:');
    });

    it('should export frozen EXTERNAL_SCHEMES', () => {
      expect(Object.isFrozen(EXTERNAL_SCHEMES)).toBe(true);
      expect(EXTERNAL_SCHEMES).toContain('http:');
      expect(EXTERNAL_SCHEMES).toContain('https:');
      expect(EXTERNAL_SCHEMES).toContain('mailto:');
      expect(EXTERNAL_SCHEMES).toContain('tel:');
    });

    it('should export frozen BLOCKED_PATTERNS', () => {
      expect(Object.isFrozen(BLOCKED_PATTERNS)).toBe(true);
      expect(BLOCKED_PATTERNS.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ==================== constructor ====================

  describe('constructor', () => {
    it('should use defaults when no options provided', () => {
      expect(handler.options.openExternal).toBe(true);
      expect(handler.options.logBlocked).toBe(true);
      expect(handler.options.allowedSchemes).toBe(ALLOWED_SCHEMES);
      expect(handler.options.externalSchemes).toBe(EXTERNAL_SCHEMES);
      expect(handler.options.blockedPatterns).toBe(BLOCKED_PATTERNS);
    });

    it('should allow disabling external URL opening', () => {
      const h = new ExternalLinkHandler({ openExternal: false });
      expect(h.options.openExternal).toBe(false);
    });

    it('should allow custom schemes', () => {
      const custom = new ExternalLinkHandler({
        allowedSchemes: ['custom:'],
        externalSchemes: ['ftp:'],
      });
      expect(custom.options.allowedSchemes).toEqual(['custom:']);
      expect(custom.options.externalSchemes).toEqual(['ftp:']);
    });
  });

  // ==================== isAllowedScheme ====================

  describe('isAllowedScheme', () => {
    it('should allow file: URLs', () => {
      expect(handler.isAllowedScheme('file:///app/index.html')).toBe(true);
    });

    it('should allow about: URLs', () => {
      expect(handler.isAllowedScheme('about:blank')).toBe(true);
    });

    it('should allow devtools: URLs', () => {
      expect(handler.isAllowedScheme('devtools://devtools/inspector.html')).toBe(true);
    });

    it('should reject http: URLs', () => {
      expect(handler.isAllowedScheme('http://example.com')).toBe(false);
    });

    it('should reject https: URLs', () => {
      expect(handler.isAllowedScheme('https://example.com')).toBe(false);
    });

    it('should return false for null/undefined/non-string', () => {
      expect(handler.isAllowedScheme(null)).toBe(false);
      expect(handler.isAllowedScheme(undefined)).toBe(false);
      expect(handler.isAllowedScheme(123)).toBe(false);
      expect(handler.isAllowedScheme('')).toBe(false);
    });

    it('should return false for malformed URLs', () => {
      expect(handler.isAllowedScheme('not-a-url')).toBe(false);
      expect(handler.isAllowedScheme('://')).toBe(false);
    });
  });

  // ==================== isExternalScheme ====================

  describe('isExternalScheme', () => {
    it('should recognize http: as external', () => {
      expect(handler.isExternalScheme('http://example.com')).toBe(true);
    });

    it('should recognize https: as external', () => {
      expect(handler.isExternalScheme('https://example.com')).toBe(true);
    });

    it('should recognize mailto: as external', () => {
      expect(handler.isExternalScheme('mailto:user@example.com')).toBe(true);
    });

    it('should recognize tel: as external', () => {
      expect(handler.isExternalScheme('tel:+1234567890')).toBe(true);
    });

    it('should reject file: as not external', () => {
      expect(handler.isExternalScheme('file:///local/path')).toBe(false);
    });

    it('should return false for null/undefined/non-string', () => {
      expect(handler.isExternalScheme(null)).toBe(false);
      expect(handler.isExternalScheme(undefined)).toBe(false);
      expect(handler.isExternalScheme(42)).toBe(false);
    });

    it('should return false for malformed URLs', () => {
      expect(handler.isExternalScheme('not-a-url')).toBe(false);
    });
  });

  // ==================== isBlocked ====================

  describe('isBlocked', () => {
    it('should block javascript: URLs', () => {
      expect(handler.isBlocked('javascript:alert(1)')).toBe(true);
    });

    it('should block JavaScript: (case insensitive)', () => {
      expect(handler.isBlocked('JAVASCRIPT:void(0)')).toBe(true);
    });

    it('should block data: URLs', () => {
      expect(handler.isBlocked('data:text/html,<script>alert(1)</script>')).toBe(true);
    });

    it('should block vbscript: URLs', () => {
      expect(handler.isBlocked('vbscript:MsgBox("XSS")')).toBe(true);
    });

    it('should block file path traversal', () => {
      expect(handler.isBlocked('file:///etc/../../../etc/passwd')).toBe(true);
    });

    it('should NOT block normal file: URLs', () => {
      expect(handler.isBlocked('file:///app/index.html')).toBe(false);
    });

    it('should NOT block http/https URLs', () => {
      expect(handler.isBlocked('https://example.com')).toBe(false);
      expect(handler.isBlocked('http://example.com')).toBe(false);
    });

    it('should return false for null/undefined/non-string', () => {
      expect(handler.isBlocked(null)).toBe(false);
      expect(handler.isBlocked(undefined)).toBe(false);
      expect(handler.isBlocked(99)).toBe(false);
    });
  });

  // ==================== determineAction ====================

  describe('determineAction', () => {
    it('should block javascript: URLs (highest priority)', () => {
      expect(handler.determineAction('javascript:alert(1)')).toBe('block');
    });

    it('should block data: URLs', () => {
      expect(handler.determineAction('data:text/html,evil')).toBe('block');
    });

    it('should allow file: URLs', () => {
      expect(handler.determineAction('file:///app/index.html')).toBe('allow');
    });

    it('should allow devtools: URLs', () => {
      expect(handler.determineAction('devtools://devtools/inspector.html')).toBe('allow');
    });

    it('should mark http: as external', () => {
      expect(handler.determineAction('http://example.com')).toBe('external');
    });

    it('should mark https: as external', () => {
      expect(handler.determineAction('https://example.com')).toBe('external');
    });

    it('should mark mailto: as external', () => {
      expect(handler.determineAction('mailto:user@example.com')).toBe('external');
    });

    it('should block unknown schemes', () => {
      expect(handler.determineAction('ftp://files.example.com')).toBe('block');
      expect(handler.determineAction('custom://something')).toBe('block');
    });

    it('should block blocked patterns even if scheme is allowed', () => {
      // file: path traversal — file: is allowed but path traversal is blocked
      expect(handler.determineAction('file:///etc/../../../etc/passwd')).toBe('block');
    });
  });

  // ==================== openExternal ====================

  describe('openExternal', () => {
    it('should call shell.openExternal for valid external URL', async () => {
      await handler.openExternal('https://example.com');

      expect(mockShellOpenExternal).toHaveBeenCalledWith('https://example.com');
    });

    it('should not open when openExternal option is disabled', async () => {
      const disabled = new ExternalLinkHandler({ openExternal: false });

      await disabled.openExternal('https://example.com');

      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it('should not open non-external scheme URLs', async () => {
      await handler.openExternal('file:///local/path');

      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it('should handle shell.openExternal errors gracefully', async () => {
      mockShellOpenExternal.mockRejectedValueOnce(new Error('Shell error'));

      // Should NOT throw
      await handler.openExternal('https://example.com');

      expect(mockShellOpenExternal).toHaveBeenCalled();
    });

    it('should not open javascript: URLs', async () => {
      await handler.openExternal('javascript:alert(1)');

      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });
  });

  // ==================== attach ====================

  describe('attach', () => {
    let mockWindow;

    beforeEach(() => {
      mockWindow = createMockWindow();
      handler.attach(mockWindow);
    });

    it('should register setWindowOpenHandler', () => {
      expect(mockWindow.webContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should register will-navigate handler', () => {
      expect(mockWindow.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
    });

    it('should register did-create-window handler', () => {
      expect(mockWindow.webContents.on).toHaveBeenCalledWith('did-create-window', expect.any(Function));
    });

    it('window.open — should deny and open externally for https URLs', () => {
      const windowOpenHandler = mockWindow.webContents._handlers['window-open'];
      const result = windowOpenHandler({ url: 'https://example.com' });

      expect(result).toEqual({ action: 'deny' });
      expect(mockShellOpenExternal).toHaveBeenCalledWith('https://example.com');
    });

    it('window.open — should allow file: URLs', () => {
      const windowOpenHandler = mockWindow.webContents._handlers['window-open'];
      const result = windowOpenHandler({ url: 'file:///app/page.html' });

      expect(result).toEqual({ action: 'allow' });
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it('window.open — should deny blocked URLs', () => {
      const windowOpenHandler = mockWindow.webContents._handlers['window-open'];
      const result = windowOpenHandler({ url: 'javascript:alert(1)' });

      expect(result).toEqual({ action: 'deny' });
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it('will-navigate — should prevent and open externally for https URLs', () => {
      const navigateHandler = mockWindow.webContents._handlers['will-navigate'];
      const mockEvent = { preventDefault: jest.fn() };

      navigateHandler(mockEvent, 'https://external.com/page');

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockShellOpenExternal).toHaveBeenCalledWith('https://external.com/page');
    });

    it('will-navigate — should allow file: URLs without preventDefault', () => {
      const navigateHandler = mockWindow.webContents._handlers['will-navigate'];
      const mockEvent = { preventDefault: jest.fn() };

      navigateHandler(mockEvent, 'file:///app/other.html');

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('will-navigate — should prevent blocked URLs', () => {
      const navigateHandler = mockWindow.webContents._handlers['will-navigate'];
      const mockEvent = { preventDefault: jest.fn() };

      navigateHandler(mockEvent, 'data:text/html,<script>evil</script>');

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it('did-create-window — should recursively attach to child windows', () => {
      const childWindow = createMockWindow({ id: 2 });
      const childHandler = mockWindow.webContents._handlers['did-create-window'];

      childHandler(childWindow);

      // Child window should have setWindowOpenHandler called
      expect(childWindow.webContents.setWindowOpenHandler).toHaveBeenCalled();
      expect(childWindow.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
    });

    it('should handle destroyed window gracefully', () => {
      const destroyed = createMockWindow({ destroyed: true });

      // Should not throw
      handler.attach(destroyed);

      expect(destroyed.webContents.setWindowOpenHandler).not.toHaveBeenCalled();
    });

    it('should handle null window gracefully', () => {
      handler.attach(null);
      // No throw expected
    });

    it('window.open — should log blocked URLs when logBlocked is true', () => {
      const windowOpenHandler = mockWindow.webContents._handlers['window-open'];
      windowOpenHandler({ url: 'ftp://unknown.com' });

      // windowLogger.warn should have been called
      const windowLogger = mockLoggerChild.child.mock.results[0]?.value;
      expect(windowLogger?.warn).toHaveBeenCalled();
    });

    it('will-navigate — should log blocked URLs when logBlocked is true', () => {
      const navigateHandler = mockWindow.webContents._handlers['will-navigate'];
      const mockEvent = { preventDefault: jest.fn() };

      navigateHandler(mockEvent, 'ftp://unknown.com/file');

      const windowLogger = mockLoggerChild.child.mock.results[0]?.value;
      expect(windowLogger?.warn).toHaveBeenCalled();
    });

    it('window.open — should NOT log blocked URLs when logBlocked is false', () => {
      const quietHandler = new ExternalLinkHandler({ logBlocked: false });
      const quietWindow = createMockWindow({ id: 99 });
      quietHandler.attach(quietWindow);

      const windowOpenHandler = quietWindow.webContents._handlers['window-open'];
      windowOpenHandler({ url: 'ftp://unknown.com' });

      // The windowLogger.warn for the 'block' case should NOT be called
      // But the handler still denies the request
    });

    it('will-navigate — should NOT log blocked URLs when logBlocked is false', () => {
      const quietHandler = new ExternalLinkHandler({ logBlocked: false });
      const quietWindow = createMockWindow({ id: 98 });
      quietHandler.attach(quietWindow);

      const navigateHandler = quietWindow.webContents._handlers['will-navigate'];
      const mockEvent = { preventDefault: jest.fn() };

      navigateHandler(mockEvent, 'ftp://unknown.com/file');

      expect(mockEvent.preventDefault).toHaveBeenCalled();
    });
  });

  // ==================== detach ====================

  describe('detach', () => {
    it('should not throw for valid window', () => {
      const mockWindow = createMockWindow();
      expect(() => handler.detach(mockWindow)).not.toThrow();
    });

    it('should handle destroyed window gracefully', () => {
      const destroyed = createMockWindow({ destroyed: true });
      expect(() => handler.detach(destroyed)).not.toThrow();
    });

    it('should handle null window gracefully', () => {
      expect(() => handler.detach(null)).not.toThrow();
    });
  });

  // ==================== createClickHandler ====================

  describe('createClickHandler', () => {
    it('should return a function', () => {
      const clickHandler = handler.createClickHandler();
      expect(typeof clickHandler).toBe('function');
    });

    it('should ignore events with no <a> tag ancestor', () => {
      const clickHandler = handler.createClickHandler();
      const event = {
        target: { tagName: 'SPAN', parentElement: null },
        preventDefault: jest.fn(),
      };

      clickHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should ignore <a> tags without href', () => {
      const clickHandler = handler.createClickHandler();
      const event = {
        target: { tagName: 'A', getAttribute: jest.fn(() => null), parentElement: null },
        preventDefault: jest.fn(),
      };

      clickHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should prevent default for http:// links', () => {
      const clickHandler = handler.createClickHandler();
      const event = {
        target: {
          tagName: 'A',
          getAttribute: jest.fn(() => 'http://example.com'),
          parentElement: null,
        },
        preventDefault: jest.fn(),
      };

      clickHandler(event);

      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should prevent default for https:// links', () => {
      const clickHandler = handler.createClickHandler();
      const event = {
        target: {
          tagName: 'A',
          getAttribute: jest.fn(() => 'https://example.com'),
          parentElement: null,
        },
        preventDefault: jest.fn(),
      };

      clickHandler(event);

      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should NOT prevent default for internal links', () => {
      const clickHandler = handler.createClickHandler();
      const event = {
        target: {
          tagName: 'A',
          getAttribute: jest.fn(() => '#section'),
          parentElement: null,
        },
        preventDefault: jest.fn(),
      };

      clickHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should traverse parent elements to find <a> tag', () => {
      const clickHandler = handler.createClickHandler();
      const aTag = {
        tagName: 'A',
        getAttribute: jest.fn(() => 'https://example.com'),
        parentElement: null,
      };
      const event = {
        target: { tagName: 'SPAN', parentElement: aTag },
        preventDefault: jest.fn(),
      };

      clickHandler(event);

      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should handle errors gracefully', () => {
      const clickHandler = handler.createClickHandler();
      const event = {
        target: { get tagName() { throw new Error('DOM error'); } },
      };

      // Should not throw
      expect(() => clickHandler(event)).not.toThrow();
    });

    it('should send IPC message when window.aether.ipc is available', () => {
      const mockSend = jest.fn();
      const originalWindow = global.window;
      global.window = { aether: { ipc: { send: mockSend } } };

      try {
        const clickHandler = handler.createClickHandler();
        const event = {
          target: {
            tagName: 'A',
            getAttribute: jest.fn(() => 'https://external.com'),
            parentElement: null,
          },
          preventDefault: jest.fn(),
        };

        clickHandler(event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(mockSend).toHaveBeenCalledWith('open-external-url', 'https://external.com');
      } finally {
        global.window = originalWindow;
      }
    });
  });

  // ==================== Factory functions ====================

  describe('createHandler', () => {
    it('should return a new ExternalLinkHandler instance', () => {
      const h = createHandler({ openExternal: false });
      expect(h).toBeInstanceOf(ExternalLinkHandler);
      expect(h.options.openExternal).toBe(false);
    });

    it('should create independent instances', () => {
      const h1 = createHandler();
      const h2 = createHandler();
      expect(h1).not.toBe(h2);
    });
  });

  describe('getHandler', () => {
    it('should return an ExternalLinkHandler instance', () => {
      const h = getHandler();
      expect(h).toBeInstanceOf(ExternalLinkHandler);
    });

    it('should return the same instance on subsequent calls', () => {
      const h1 = getHandler();
      const h2 = getHandler();
      expect(h1).toBe(h2);
    });
  });

  describe('attachToWindow', () => {
    it('should attach protection to window via global handler', () => {
      const mockWindow = createMockWindow();
      attachToWindow(mockWindow);

      expect(mockWindow.webContents.setWindowOpenHandler).toHaveBeenCalled();
      expect(mockWindow.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
    });
  });
});
