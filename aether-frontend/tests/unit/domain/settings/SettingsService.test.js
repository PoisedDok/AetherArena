'use strict';

/**
 * SettingsService Unit Tests
 * Tests the settings domain SettingsService with proper structure
 */

const { SettingsService } = require('../../../../src/domain/settings/services/SettingsService');
const { Settings } = require('../../../../src/domain/settings/models/Settings');

describe('SettingsService', () => {
  let service;
  let mockRepository;
  
  beforeEach(() => {
    // Create properly structured settings data
    const mockSettingsData = {
      interpreter: {
        auto_run: false,
        loop: false,
        safe_mode: 'off',
        profile: 'guru_integration.py'
      },
      llm: {
        provider: 'openai',
        model: 'gpt-4',
        context_window: 8000,
        max_tokens: 4000,
        supports_vision: true
      },
      voice: {
        mic_button_enabled: true,
        stt: {
          provider: 'whisper',
          language: 'en'
        },
        tts: {
          provider: 'elevenlabs',
          voice: 'default'
        }
      },
      memory: {
        enabled: true,
        type: 'sqlite'
      },
      security: {
        bind_host: '0.0.0.0',
        auth: {
          enabled: false
        }
      }
    };

    mockRepository = {
      loadSettings: jest.fn().mockResolvedValue({
        settings: new Settings(mockSettingsData),
        source: 'backend'
      }),
      saveSettings: jest.fn().mockResolvedValue({ success: true, source: 'backend' }),
    };
    
    service = new SettingsService({ repository: mockRepository });
  });

  afterEach(() => {
    service = null;
    mockRepository = null;
  });

  describe('loadSettings', () => {
    it('should load settings from repository', async () => {
      const result = await service.loadSettings();
      
      expect(result).toBeTruthy();
      expect(result.settings).toBeTruthy();
      expect(mockRepository.loadSettings).toHaveBeenCalled();
    });

    it('should use defaults when loading fails', async () => {
      mockRepository.loadSettings.mockRejectedValue(new Error('Load failed'));
      
      await expect(service.loadSettings()).rejects.toThrow();
    });
  });

  describe('saveSettings', () => {
    it('should save valid settings', async () => {
      const validSettings = {
        interpreter: {
          auto_run: true,
          loop: false,
          safe_mode: 'ask',
          profile: 'guru_integration.py'
        },
        llm: {
          provider: 'openai',
          model: 'gpt-4',
          context_window: 8000,
          max_tokens: 2000,
          supports_vision: true
        },
        voice: {
          mic_button_enabled: true
        },
        memory: {
          enabled: true,
          type: 'sqlite'
        },
        security: {
          bind_host: '127.0.0.1'
        }
      };
      
      const result = await service.saveSettings(validSettings);
      
      expect(result.success).toBe(true);
      expect(mockRepository.saveSettings).toHaveBeenCalled();
    });

    it('should reject invalid LLM settings', async () => {
      const invalidSettings = {
        llm: {
          context_window: 500  // Too small, must be at least 1000
        }
      };
      
      await expect(service.saveSettings(invalidSettings)).rejects.toThrow();
      expect(mockRepository.saveSettings).not.toHaveBeenCalled();
    });

    it('should reject invalid safe_mode value', async () => {
      const invalidSettings = {
        interpreter: {
          safe_mode: 'invalid_mode'  // Must be 'off', 'ask', or 'auto'
        }
      };
      
      await expect(service.saveSettings(invalidSettings)).rejects.toThrow();
      expect(mockRepository.saveSettings).not.toHaveBeenCalled();
    });
  });

  describe('getSettings', () => {
    it('should return current settings', () => {
      const settings = service.getSettings();
      
      expect(settings).toBeTruthy();
      expect(settings).toBeInstanceOf(Settings);
    });
  });

  describe('validateSettings', () => {
    it('should validate correct interpreter settings', () => {
      const validSettings = {
        interpreter: {
          auto_run: true,
          loop: false,
          safe_mode: 'ask'
        }
      };
      
      expect(() => service.validateSettings(validSettings)).not.toThrow();
    });

    it('should reject invalid interpreter settings', () => {
      const invalidSettings = {
        interpreter: {
          safe_mode: 'invalid'  // Should be 'off', 'ask', or 'auto'
        }
      };
      
      expect(() => service.validateSettings(invalidSettings)).toThrow();
    });

    it('should validate correct LLM settings', () => {
      const validSettings = {
        llm: {
          provider: 'openai',
          model: 'gpt-4',
          context_window: 8000,
          max_tokens: 4000
        }
      };
      
      expect(() => service.validateSettings(validSettings)).not.toThrow();
    });

    it('should reject LLM settings with low context_window', () => {
      const invalidSettings = {
        llm: {
          context_window: 500  // Too small
        }
      };
      
      expect(() => service.validateSettings(invalidSettings)).toThrow();
    });

    it('should validate voice settings', () => {
      const validSettings = {
        voice: {
          mic_button_enabled: true,
          stt: {
            provider: 'whisper',
            sample_rate_hz: 16000,
            language: 'en'
          }
        }
      };
      
      expect(() => service.validateSettings(validSettings)).not.toThrow();
    });

    it('should reject invalid sample rate', () => {
      const invalidSettings = {
        voice: {
          stt: {
            sample_rate_hz: 100  // Too low, must be 8000-48000
          }
        }
      };
      
      expect(() => service.validateSettings(invalidSettings)).toThrow();
    });

    it('should validate memory settings', () => {
      const validSettings = {
        memory: {
          enabled: true,
          type: 'sqlite',
          retrieval: {
            enabled: true,
            top_k: 5
          }
        }
      };
      
      expect(() => service.validateSettings(validSettings)).not.toThrow();
    });

    it('should reject invalid memory type', () => {
      const invalidSettings = {
        memory: {
          type: 'invalid_type'  // Must be 'sqlite', 'postgres', or 'redis'
        }
      };
      
      expect(() => service.validateSettings(invalidSettings)).toThrow();
    });
  });
});
