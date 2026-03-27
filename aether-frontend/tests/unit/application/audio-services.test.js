'use strict';

// =============================================================================
// Mocks (before require)
// =============================================================================

const mockAudioManagerInstance = { type: 'AudioManager' };
const MockAudioManager = jest.fn(() => mockAudioManagerInstance);

const mockDefaultConfig = { sampleRate: 16000, channels: 1 };
const MockAudioConfig = {
  createDefault: jest.fn(() => mockDefaultConfig),
};

const mockHandsfreeInstance = { type: 'HandsfreeCoordinator' };
const MockHandsfreeCoordinator = jest.fn(() => mockHandsfreeInstance);

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../src/domain/audio/services/AudioManager', () => ({
  AudioManager: MockAudioManager,
}));

jest.mock('../../../src/domain/audio/models/AudioConfig', () => ({
  AudioConfig: MockAudioConfig,
}));

jest.mock('../../../src/domain/audio/services/HandsfreeCoordinator', () => ({
  HandsfreeCoordinator: MockHandsfreeCoordinator,
}));

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLogger),
}));

const { AudioServices } = require('../../../src/application/audio/AudioServices');

// =============================================================================
// Tests
// =============================================================================

describe('AudioServices', () => {
  let services;

  beforeEach(() => {
    services = new AudioServices();
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // createDefaultConfig
  // ---------------------------------------------------------------------------

  describe('createDefaultConfig()', () => {
    it('delegates to AudioConfig.createDefault()', () => {
      const result = services.createDefaultConfig();

      expect(MockAudioConfig.createDefault).toHaveBeenCalledTimes(1);
      expect(result).toBe(mockDefaultConfig);
    });

    it('returns a new config on each call', () => {
      const config2 = { sampleRate: 44100 };
      MockAudioConfig.createDefault.mockReturnValueOnce(config2);

      const result = services.createDefaultConfig();

      expect(result).toBe(config2);
    });
  });

  // ---------------------------------------------------------------------------
  // createAudioManager
  // ---------------------------------------------------------------------------

  describe('createAudioManager()', () => {
    const validArgs = {
      eventBus: { emit: jest.fn() },
      endpoint: { send: jest.fn() },
      config: { sampleRate: 16000 },
    };

    it('creates AudioManager with correct dependencies', () => {
      const result = services.createAudioManager(validArgs);

      expect(MockAudioManager).toHaveBeenCalledTimes(1);
      expect(MockAudioManager).toHaveBeenCalledWith({
        eventBus: validArgs.eventBus,
        endpoint: validArgs.endpoint,
        config: validArgs.config,
      });
      expect(result).toBe(mockAudioManagerInstance);
    });

    it('throws when config is missing', () => {
      expect(() => {
        services.createAudioManager({ eventBus: {}, endpoint: {} });
      }).toThrow('[AudioServices] config is required to create AudioManager');
    });

    it('throws when config is null', () => {
      expect(() => {
        services.createAudioManager({ eventBus: {}, endpoint: {}, config: null });
      }).toThrow('[AudioServices] config is required to create AudioManager');
    });

    it('allows optional eventBus and endpoint (AudioManager owns validation)', () => {
      const result = services.createAudioManager({ config: { sampleRate: 16000 } });

      expect(MockAudioManager).toHaveBeenCalledWith({
        eventBus: undefined,
        endpoint: undefined,
        config: { sampleRate: 16000 },
      });
      expect(result).toBe(mockAudioManagerInstance);
    });
  });

  // ---------------------------------------------------------------------------
  // createHandsfreeCoordinator
  // ---------------------------------------------------------------------------

  describe('createHandsfreeCoordinator()', () => {
    const validArgs = {
      audioManager: { type: 'AudioManager' },
      eventBus: { emit: jest.fn() },
      endpoint: { send: jest.fn() },
      config: { sampleRate: 16000 },
    };

    it('creates HandsfreeCoordinator with correct dependencies', () => {
      const result = services.createHandsfreeCoordinator(validArgs);

      expect(MockHandsfreeCoordinator).toHaveBeenCalledTimes(1);
      expect(MockHandsfreeCoordinator).toHaveBeenCalledWith({
        audioManager: validArgs.audioManager,
        eventBus: validArgs.eventBus,
        endpoint: validArgs.endpoint,
        config: validArgs.config,
        log: mockLogger,
      });
      expect(result).toBe(mockHandsfreeInstance);
    });

    it('throws when audioManager is missing', () => {
      expect(() => {
        services.createHandsfreeCoordinator({ eventBus: {}, endpoint: {}, config: {} });
      }).toThrow('[AudioServices] audioManager is required to create HandsfreeCoordinator');
    });

    it('throws when audioManager is null', () => {
      expect(() => {
        services.createHandsfreeCoordinator({ audioManager: null, eventBus: {}, endpoint: {}, config: {} });
      }).toThrow('[AudioServices] audioManager is required to create HandsfreeCoordinator');
    });

    it('creates a renderer logger with correct module name', () => {
      const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');

      services.createHandsfreeCoordinator(validArgs);

      expect(createRendererLogger).toHaveBeenCalledWith('HandsfreeCoordinator');
    });

    it('passes logger instance to HandsfreeCoordinator', () => {
      services.createHandsfreeCoordinator(validArgs);

      const passedArgs = MockHandsfreeCoordinator.mock.calls[0][0];
      expect(passedArgs.log).toBe(mockLogger);
    });
  });
});
