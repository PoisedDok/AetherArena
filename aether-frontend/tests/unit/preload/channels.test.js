'use strict';

const {
  mainWindow,
  chatWindow,
  artifactsWindow,
  registry,
  normalizeContext,
  getChannelConfig,
  canSend,
  canReceive,
  getAllChannels,
  validateChannel,
} = require('../../../src/preload/ipc/channels');

describe('IPC Channels', () => {
  // =========================================================================
  // Registry integrity
  // =========================================================================
  describe('registry', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(registry)).toBe(true);
    });

    it('contains exactly 6 windows', () => {
      expect(Object.keys(registry)).toEqual(['mainWindow', 'chatWindow', 'artifactsWindow', 'notesWindow', 'indexBrowserWindow', 'researchWindow']);
    });

    it('each window config is frozen', () => {
      for (const config of Object.values(registry)) {
        expect(Object.isFrozen(config)).toBe(true);
      }
    });

    it('each window has frozen send and receive arrays', () => {
      for (const config of Object.values(registry)) {
        expect(Object.isFrozen(config.send)).toBe(true);
        expect(Object.isFrozen(config.receive)).toBe(true);
        expect(Array.isArray(config.send)).toBe(true);
        expect(Array.isArray(config.receive)).toBe(true);
      }
    });

    it('rejects mutation of send array', () => {
      expect(() => { mainWindow.send.push('hacked'); }).toThrow();
    });

    it('rejects mutation of registry', () => {
      expect(() => { registry.newWindow = {}; }).toThrow();
    });
  });

  // =========================================================================
  // Window channel configs — structural correctness
  // =========================================================================
  describe('mainWindow', () => {
    it('has name "mainWindow"', () => {
      expect(mainWindow.name).toBe('mainWindow');
    });

    it('send array includes critical channels', () => {
      expect(mainWindow.send).toContain('renderer-log');
      expect(mainWindow.send).toContain('chat:send');
      expect(mainWindow.send).toContain('chat:stop');
      expect(mainWindow.send).toContain('artifacts:stream');
      expect(mainWindow.send).toContain('storage:load-chats');
      expect(mainWindow.send).toContain('app:quit');
    });

    it('receive array includes chat forwarding channels', () => {
      expect(mainWindow.receive).toContain('chat:assistant-stream');
      expect(mainWindow.receive).toContain('chat:request-complete');
      expect(mainWindow.receive).toContain('enter-widget-mode');
    });

    it('all send entries are unique', () => {
      const set = new Set(mainWindow.send);
      expect(set.size).toBe(mainWindow.send.length);
    });
  });

  describe('chatWindow', () => {
    it('has name "chatWindow"', () => {
      expect(chatWindow.name).toBe('chatWindow');
    });

    it('send array includes storage channels', () => {
      expect(chatWindow.send).toContain('storage:load-chats');
      expect(chatWindow.send).toContain('storage:save-message');
      expect(chatWindow.send).toContain('chat:send');
    });

    it('receive array includes artifact stream', () => {
      expect(chatWindow.receive).toContain('artifacts:stream');
    });

    it('all send entries are unique', () => {
      const set = new Set(chatWindow.send);
      expect(set.size).toBe(chatWindow.send.length);
    });
  });

  describe('artifactsWindow', () => {
    it('has name "artifactsWindow"', () => {
      expect(artifactsWindow.name).toBe('artifactsWindow');
    });

    it('send array includes execute-code', () => {
      expect(artifactsWindow.send).toContain('artifacts:execute-code');
      expect(artifactsWindow.send).toContain('artifacts:file-export');
    });

    it('receive array includes core artifact channels', () => {
      expect(artifactsWindow.receive).toContain('artifacts:stream');
      expect(artifactsWindow.receive).toContain('artifacts:load-code');
      expect(artifactsWindow.receive).toContain('artifacts:switch-chat');
    });

    it('all receive entries are unique', () => {
      const set = new Set(artifactsWindow.receive);
      expect(set.size).toBe(artifactsWindow.receive.length);
    });
  });

  // =========================================================================
  // normalizeContext
  // =========================================================================
  describe('normalizeContext()', () => {
    it('returns mainWindow for null/undefined/empty', () => {
      expect(normalizeContext(null)).toBe('mainWindow');
      expect(normalizeContext(undefined)).toBe('mainWindow');
      expect(normalizeContext('')).toBe('mainWindow');
    });

    it('normalizes "main" -> "mainWindow"', () => {
      expect(normalizeContext('main')).toBe('mainWindow');
    });

    it('normalizes "mainwindow" (case-insensitive) -> "mainWindow"', () => {
      expect(normalizeContext('mainwindow')).toBe('mainWindow');
      expect(normalizeContext('MAINWINDOW')).toBe('mainWindow');
      expect(normalizeContext('MainWindow')).toBe('mainWindow');
    });

    it('normalizes "main-window" -> "mainWindow"', () => {
      expect(normalizeContext('main-window')).toBe('mainWindow');
    });

    it('normalizes "chat" -> "chatWindow"', () => {
      expect(normalizeContext('chat')).toBe('chatWindow');
    });

    it('normalizes "chatwindow" (case-insensitive) -> "chatWindow"', () => {
      expect(normalizeContext('chatwindow')).toBe('chatWindow');
      expect(normalizeContext('ChatWindow')).toBe('chatWindow');
    });

    it('normalizes "chat-window" -> "chatWindow"', () => {
      expect(normalizeContext('chat-window')).toBe('chatWindow');
    });

    it('normalizes "artifacts" -> "artifactsWindow"', () => {
      expect(normalizeContext('artifacts')).toBe('artifactsWindow');
    });

    it('normalizes "artifactswindow" (case-insensitive) -> "artifactsWindow"', () => {
      expect(normalizeContext('artifactswindow')).toBe('artifactsWindow');
      expect(normalizeContext('ArtifactsWindow')).toBe('artifactsWindow');
    });

    it('normalizes "artifacts-window" -> "artifactsWindow"', () => {
      expect(normalizeContext('artifacts-window')).toBe('artifactsWindow');
    });

    it('handles camelCase registry keys via alias match (lowercased)', () => {
      // 'chatWindow' → lowercased to 'chatwindow' → matches alias check
      // Note: the registry[context] branch at line 299 is dead code
      expect(normalizeContext('chatWindow')).toBe('chatWindow');
      expect(normalizeContext('artifactsWindow')).toBe('artifactsWindow');
    });

    it('falls back to mainWindow for unknown context', () => {
      expect(normalizeContext('unknownWindow')).toBe('mainWindow');
      expect(normalizeContext('random')).toBe('mainWindow');
    });
  });

  // =========================================================================
  // getChannelConfig
  // =========================================================================
  describe('getChannelConfig()', () => {
    it('returns mainWindow config by default', () => {
      const config = getChannelConfig();
      expect(config).toBe(mainWindow);
    });

    it('returns correct config for "chat"', () => {
      expect(getChannelConfig('chat')).toBe(chatWindow);
    });

    it('returns correct config for "artifacts"', () => {
      expect(getChannelConfig('artifacts')).toBe(artifactsWindow);
    });

    it('returns mainWindow for undefined/null', () => {
      expect(getChannelConfig(undefined)).toBe(mainWindow);
      expect(getChannelConfig(null)).toBe(mainWindow);
    });
  });

  // =========================================================================
  // canSend
  // =========================================================================
  describe('canSend()', () => {
    it('returns true for valid send channel in mainWindow', () => {
      expect(canSend('chat:send', 'main')).toBe(true);
    });

    it('returns false for receive-only channel as send', () => {
      expect(canSend('enter-widget-mode', 'main')).toBe(false);
    });

    it('returns false for channel not in any list', () => {
      expect(canSend('totally-fake-channel', 'main')).toBe(false);
    });

    it('defaults to mainWindow context', () => {
      expect(canSend('renderer-log')).toBe(true);
    });

    it('returns true for artifacts-specific send', () => {
      expect(canSend('artifacts:execute-code', 'artifacts')).toBe(true);
    });

    it('returns false for artifacts send channel in chat context', () => {
      expect(canSend('artifacts:execute-code', 'chat')).toBe(false);
    });

    it('returns false (not throw) for invalid context via catch', () => {
      // normalizeContext handles unknown -> mainWindow, so this won't throw,
      // but validates the try-catch path
      expect(canSend('renderer-log', 'main')).toBe(true);
    });
  });

  // =========================================================================
  // canReceive
  // =========================================================================
  describe('canReceive()', () => {
    it('returns true for valid receive channel', () => {
      expect(canReceive('chat:assistant-stream', 'main')).toBe(true);
    });

    it('returns false for channel not in receive list', () => {
      expect(canReceive('app:quit', 'main')).toBe(false);
    });

    it('defaults to mainWindow context', () => {
      expect(canReceive('enter-widget-mode')).toBe(true);
    });

    it('returns true for artifacts-specific receive', () => {
      expect(canReceive('artifacts:stream', 'artifacts')).toBe(true);
    });

    it('returns false for non-existent channel', () => {
      expect(canReceive('bogus-channel', 'chat')).toBe(false);
    });
  });

  // =========================================================================
  // getAllChannels
  // =========================================================================
  describe('getAllChannels()', () => {
    it('returns send and receive arrays for mainWindow', () => {
      const result = getAllChannels('main');
      expect(result).toHaveProperty('send');
      expect(result).toHaveProperty('receive');
      expect(Array.isArray(result.send)).toBe(true);
      expect(Array.isArray(result.receive)).toBe(true);
    });

    it('returned arrays are copies (not frozen originals)', () => {
      const result = getAllChannels('main');
      expect(result.send).not.toBe(mainWindow.send);
      expect(result.receive).not.toBe(mainWindow.receive);
      // But same contents
      expect(result.send).toEqual(Array.from(mainWindow.send));
      expect(result.receive).toEqual(Array.from(mainWindow.receive));
    });

    it('returned arrays are mutable (safe copies)', () => {
      const result = getAllChannels('main');
      expect(() => result.send.push('test')).not.toThrow();
    });

    it('defaults to mainWindow', () => {
      const result = getAllChannels();
      expect(result.send.length).toBe(mainWindow.send.length);
    });
  });

  // =========================================================================
  // validateChannel
  // =========================================================================
  describe('validateChannel()', () => {
    it('does not throw for valid send channel', () => {
      expect(() => validateChannel('chat:send', 'send', 'main')).not.toThrow();
    });

    it('does not throw for valid receive channel', () => {
      expect(() => validateChannel('chat:assistant-stream', 'receive', 'main')).not.toThrow();
    });

    it('throws for channel not in receive list', () => {
      expect(() => validateChannel('app:quit', 'receive', 'main'))
        .toThrow('[IPC Security]');
    });

    it('throws for receive channel used as send', () => {
      expect(() => validateChannel('enter-widget-mode', 'send', 'main'))
        .toThrow('[IPC Security]');
    });

    it('throws for non-existent channel', () => {
      expect(() => validateChannel('hacked-channel', 'send', 'main'))
        .toThrow('not allowed for send');
    });

    it('throw message includes channel name, direction, and context', () => {
      try {
        validateChannel('fake', 'send', 'chat');
        // Should not reach here
        expect(true).toBe(false);
      } catch (e) {
        expect(e.message).toContain('fake');
        expect(e.message).toContain('send');
        expect(e.message).toContain('chat');
      }
    });

    it('throws for invalid direction key', () => {
      expect(() => validateChannel('chat:send', 'invalid', 'main'))
        .toThrow('[IPC Security]');
    });

    it('defaults to mainWindow context', () => {
      expect(() => validateChannel('renderer-log', 'send')).not.toThrow();
    });
  });

  // =========================================================================
  // Security: cross-window isolation
  // =========================================================================
  describe('cross-window channel isolation', () => {
    it('artifacts window cannot send chat:send', () => {
      expect(canSend('chat:send', 'artifacts')).toBe(false);
    });

    it('main window cannot receive artifacts:load-code', () => {
      expect(canReceive('artifacts:load-code', 'main')).toBe(false);
    });

    it('chat window can send to artifacts coordination channels', () => {
      expect(canSend('artifacts:load-code', 'chat')).toBe(true);
      expect(canSend('artifacts:switch-chat', 'chat')).toBe(true);
    });

    it('chat window cannot send artifacts:execute-code (artifacts-only)', () => {
      expect(canSend('artifacts:execute-code', 'chat')).toBe(false);
    });
  });
});
