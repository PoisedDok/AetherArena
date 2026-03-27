'use strict';

const path = require('path');
const fs = require('fs');

// Mock fs at boundary — pure I/O
jest.mock('fs');

const { resolvePreloadPath } = require('../../../src/main/utils/preload-utils');

const WINDOW_DIR = '/app/src/main/windows';
const FILENAME = 'main-preload.js';
const BUILD_PATH = path.join(WINDOW_DIR, '../../../build/preload', FILENAME);
const SRC_PATH = path.join(WINDOW_DIR, '../../preload', FILENAME);

// Preserve original env for restoration
const origEnv = { ...process.env };

afterEach(() => {
  process.env.ELECTRON_DEV = origEnv.ELECTRON_DEV;
  process.env.NODE_ENV = origEnv.NODE_ENV;
  jest.resetAllMocks();
});

describe('preload-utils: resolvePreloadPath', () => {
  // ── Input validation ─────────────────────────────────────────────────

  describe('input validation', () => {
    it('throws on null windowModuleDir', () => {
      expect(() => resolvePreloadPath(null, FILENAME))
        .toThrow('[PreloadUtils] windowModuleDir must be a non-empty string');
    });

    it('throws on undefined windowModuleDir', () => {
      expect(() => resolvePreloadPath(undefined, FILENAME))
        .toThrow('[PreloadUtils] windowModuleDir must be a non-empty string');
    });

    it('throws on empty string windowModuleDir', () => {
      expect(() => resolvePreloadPath('', FILENAME))
        .toThrow('[PreloadUtils] windowModuleDir must be a non-empty string');
    });

    it('throws on numeric windowModuleDir', () => {
      expect(() => resolvePreloadPath(42, FILENAME))
        .toThrow('[PreloadUtils] windowModuleDir must be a non-empty string');
    });

    it('throws on null preloadFilename', () => {
      expect(() => resolvePreloadPath(WINDOW_DIR, null))
        .toThrow('[PreloadUtils] preloadFilename must be a non-empty string');
    });

    it('throws on empty string preloadFilename', () => {
      expect(() => resolvePreloadPath(WINDOW_DIR, ''))
        .toThrow('[PreloadUtils] preloadFilename must be a non-empty string');
    });

    it('throws on numeric preloadFilename', () => {
      expect(() => resolvePreloadPath(WINDOW_DIR, 123))
        .toThrow('[PreloadUtils] preloadFilename must be a non-empty string');
    });
  });

  // ── Resolution logic ────────────────────────────────────────────────

  describe('build path preferred', () => {
    it('returns build path when build artifact exists', () => {
      fs.existsSync.mockReturnValue(true);
      const result = resolvePreloadPath(WINDOW_DIR, FILENAME);
      expect(result).toBe(BUILD_PATH);
      expect(fs.existsSync).toHaveBeenCalledWith(BUILD_PATH);
    });

    it('returns build path regardless of dev/prod mode', () => {
      fs.existsSync.mockReturnValue(true);
      process.env.ELECTRON_DEV = 'true';
      process.env.NODE_ENV = 'development';
      expect(resolvePreloadPath(WINDOW_DIR, FILENAME)).toBe(BUILD_PATH);
    });
  });

  describe('dev mode without build', () => {
    it('throws when ELECTRON_DEV=true and build missing', () => {
      fs.existsSync.mockReturnValue(false);
      process.env.ELECTRON_DEV = 'true';
      process.env.NODE_ENV = 'test';
      expect(() => resolvePreloadPath(WINDOW_DIR, FILENAME))
        .toThrow(/Missing bundled preload/);
    });

    it('throws when NODE_ENV=development and build missing', () => {
      fs.existsSync.mockReturnValue(false);
      process.env.ELECTRON_DEV = 'false';
      process.env.NODE_ENV = 'development';
      expect(() => resolvePreloadPath(WINDOW_DIR, FILENAME))
        .toThrow(/Missing bundled preload/);
    });

    it('error message includes the expected build path', () => {
      fs.existsSync.mockReturnValue(false);
      process.env.ELECTRON_DEV = 'true';
      try {
        resolvePreloadPath(WINDOW_DIR, FILENAME);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e.message).toContain(BUILD_PATH);
        expect(e.message).toContain('dev requires build:preload');
      }
    });
  });

  describe('production fallback to src', () => {
    it('returns src path when build missing in non-dev', () => {
      fs.existsSync.mockReturnValue(false);
      process.env.ELECTRON_DEV = 'false';
      process.env.NODE_ENV = 'production';
      const result = resolvePreloadPath(WINDOW_DIR, FILENAME);
      expect(result).toBe(SRC_PATH);
    });

    it('returns src path when env vars are unset (test environment)', () => {
      fs.existsSync.mockReturnValue(false);
      process.env.ELECTRON_DEV = 'false';
      process.env.NODE_ENV = 'test';
      const result = resolvePreloadPath(WINDOW_DIR, FILENAME);
      expect(result).toBe(SRC_PATH);
    });
  });

  // ── Path construction ───────────────────────────────────────────────

  describe('path construction', () => {
    it('constructs correct relative paths from window dir', () => {
      fs.existsSync.mockReturnValue(true);
      const dir = '/project/src/main/windows';
      const result = resolvePreloadPath(dir, 'chat-preload.js');
      // build: /project/src/main/windows/../../../build/preload/chat-preload.js
      const expectedBuild = path.join(dir, '../../../build/preload', 'chat-preload.js');
      expect(result).toBe(expectedBuild);
    });
  });
});
