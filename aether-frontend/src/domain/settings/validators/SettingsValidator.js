'use strict';

/**
 * @.architecture
 *
 * Incoming: SettingsService.updateSettings(), SettingsRepository.save() (validation calls) --- {settings_types.*, any}
 * Processing: Validate complete settings object (5 categories: interpreter/llm/voice/memory/security), validate interpreter (auto_run/loop boolean/safe_mode enum/profile string), validate llm (provider/model/api_base/context_window/max_tokens/supports_vision), validate voice (mic_button/stt_sample_rate/tts_sample_rate ranges), validate memory (enabled/type/retrieval.top_k), validate security (bind_host/auth/allowed_origins), parse JSON for URL validation --- {2 jobs: JOB_PARSE_JSON, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return {valid, errors} object --- {validation_result_types.*, {valid:boolean, errors:string[]}}
 *
 *
 * @module domain/settings/validators/SettingsValidator
 */

/**
 * SettingsValidator
 * Validation logic for settings domain
 * 
 * Pure validation functions with no side effects
 */

class SettingsValidator {
  /**
   * Validate complete settings object
   * @param {Object} settings - Settings to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateSettings(settings) {
    const errors = [];

    if (!settings) {
      errors.push('Settings object is required');
      return { valid: false, errors };
    }

    // Validate interpreter settings
    if (settings.interpreter) {
      const interpreterErrors = this.validateInterpreterSettings(settings.interpreter);
      if (!interpreterErrors.valid) {
        errors.push(...interpreterErrors.errors);
      }
    }

    // Validate LLM settings
    if (settings.llm) {
      const llmErrors = this.validateLLMSettings(settings.llm);
      if (!llmErrors.valid) {
        errors.push(...llmErrors.errors);
      }
    }

    // Validate voice settings
    if (settings.voice) {
      const voiceErrors = this.validateVoiceSettings(settings.voice);
      if (!voiceErrors.valid) {
        errors.push(...voiceErrors.errors);
      }
    }

    // Validate memory settings
    if (settings.memory) {
      const memoryErrors = this.validateMemorySettings(settings.memory);
      if (!memoryErrors.valid) {
        errors.push(...memoryErrors.errors);
      }
    }

    // Validate security settings
    if (settings.security) {
      const securityErrors = this.validateSecuritySettings(settings.security);
      if (!securityErrors.valid) {
        errors.push(...securityErrors.errors);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate interpreter settings
   * @param {Object} interpreter - Interpreter settings
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateInterpreterSettings(interpreter) {
    const errors = [];

    if (interpreter.auto_run !== undefined && typeof interpreter.auto_run !== 'boolean') {
      errors.push('Interpreter auto_run must be boolean');
    }

    if (interpreter.loop !== undefined && typeof interpreter.loop !== 'boolean') {
      errors.push('Interpreter loop must be boolean');
    }

    if (interpreter.profile && typeof interpreter.profile !== 'string') {
      errors.push('Interpreter profile must be string');
    }

    if (interpreter.safe_mode && !['off', 'ask', 'auto'].includes(interpreter.safe_mode)) {
      errors.push('Interpreter safe_mode must be "off", "ask", or "auto"');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate LLM settings
   * @param {Object} llm - LLM settings
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateLLMSettings(llm) {
    const errors = [];

    if (llm.provider && typeof llm.provider !== 'string') {
      errors.push('LLM provider must be string');
    }

    if (llm.api_base) {
      if (typeof llm.api_base !== 'string') {
        errors.push('LLM api_base must be string');
      } else if (!this._isValidUrl(llm.api_base)) {
        errors.push('LLM api_base must be valid URL');
      }
    }

    if (llm.model && typeof llm.model !== 'string') {
      errors.push('LLM model must be string');
    }

    if (llm.context_window !== undefined) {
      if (typeof llm.context_window !== 'number') {
        errors.push('LLM context_window must be number');
      } else if (llm.context_window < 1000) {
        errors.push('LLM context_window must be at least 1000');
      }
    }

    if (llm.max_tokens !== undefined) {
      if (typeof llm.max_tokens !== 'number') {
        errors.push('LLM max_tokens must be number');
      } else if (llm.max_tokens < 100) {
        errors.push('LLM max_tokens must be at least 100');
      }
    }

    if (llm.supports_vision !== undefined && typeof llm.supports_vision !== 'boolean') {
      errors.push('LLM supports_vision must be boolean');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate voice settings
   * @param {Object} voice - Voice settings
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateVoiceSettings(voice) {
    const errors = [];

    if (voice.mic_button_enabled !== undefined && typeof voice.mic_button_enabled !== 'boolean') {
      errors.push('Voice mic_button_enabled must be boolean');
    }

    // Validate STT settings
    if (voice.stt) {
      if (voice.stt.provider && typeof voice.stt.provider !== 'string') {
        errors.push('Voice STT provider must be string');
      }

      if (voice.stt.sample_rate_hz !== undefined) {
        if (typeof voice.stt.sample_rate_hz !== 'number') {
          errors.push('Voice STT sample_rate_hz must be number');
        } else if (voice.stt.sample_rate_hz < 8000 || voice.stt.sample_rate_hz > 48000) {
          errors.push('Voice STT sample_rate_hz must be between 8000 and 48000');
        }
      }

      if (voice.stt.language && typeof voice.stt.language !== 'string') {
        errors.push('Voice STT language must be string');
      }
    }

    // Validate TTS settings
    if (voice.tts) {
      if (voice.tts.provider && typeof voice.tts.provider !== 'string') {
        errors.push('Voice TTS provider must be string');
      }

      if (voice.tts.sample_rate_hz !== undefined) {
        if (typeof voice.tts.sample_rate_hz !== 'number') {
          errors.push('Voice TTS sample_rate_hz must be number');
        } else if (voice.tts.sample_rate_hz < 8000 || voice.tts.sample_rate_hz > 48000) {
          errors.push('Voice TTS sample_rate_hz must be between 8000 and 48000');
        }
      }

      if (voice.tts.voice && typeof voice.tts.voice !== 'string') {
        errors.push('Voice TTS voice must be string');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate memory settings
   * @param {Object} memory - Memory settings
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateMemorySettings(memory) {
    const errors = [];

    if (memory.enabled !== undefined && typeof memory.enabled !== 'boolean') {
      errors.push('Memory enabled must be boolean');
    }

    if (memory.type && !['sqlite', 'postgres', 'redis'].includes(memory.type)) {
      errors.push('Memory type must be "sqlite", "postgres", or "redis"');
    }

    if (memory.path && typeof memory.path !== 'string') {
      errors.push('Memory path must be string');
    }

    if (memory.embedder && typeof memory.embedder !== 'string') {
      errors.push('Memory embedder must be string');
    }

    if (memory.retrieval) {
      if (memory.retrieval.enabled !== undefined && typeof memory.retrieval.enabled !== 'boolean') {
        errors.push('Memory retrieval enabled must be boolean');
      }

      if (memory.retrieval.top_k !== undefined) {
        if (typeof memory.retrieval.top_k !== 'number') {
          errors.push('Memory retrieval top_k must be number');
        } else if (memory.retrieval.top_k < 1) {
          errors.push('Memory retrieval top_k must be at least 1');
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate security settings
   * @param {Object} security - Security settings
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateSecuritySettings(security) {
    const errors = [];

    if (security.bind_host && typeof security.bind_host !== 'string') {
      errors.push('Security bind_host must be string');
    }

    if (security.auth) {
      if (security.auth.enabled !== undefined && typeof security.auth.enabled !== 'boolean') {
        errors.push('Security auth enabled must be boolean');
      }

      if (security.auth.token && typeof security.auth.token !== 'string') {
        errors.push('Security auth token must be string');
      }
    }

    if (security.allowed_origins && !Array.isArray(security.allowed_origins)) {
      errors.push('Security allowed_origins must be array');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate profile name
   * @param {string} profileName - Profile name
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateProfileName(profileName) {
    const errors = [];

    if (!profileName) {
      errors.push('Profile name is required');
      return { valid: false, errors };
    }

    if (typeof profileName !== 'string') {
      errors.push('Profile name must be string');
    } else if (profileName.trim().length === 0) {
      errors.push('Profile name cannot be empty');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate model name
   * @param {string} modelName - Model name
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateModelName(modelName) {
    const errors = [];

    if (!modelName) {
      errors.push('Model name is required');
      return { valid: false, errors };
    }

    if (typeof modelName !== 'string') {
      errors.push('Model name must be string');
    } else if (modelName.trim().length === 0) {
      errors.push('Model name cannot be empty');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate model capabilities
   * @param {Object} capabilities - Capabilities object
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateModelCapabilities(capabilities) {
    const errors = [];

    if (!capabilities) {
      errors.push('Capabilities object is required');
      return { valid: false, errors };
    }

    if (capabilities.supports_vision !== undefined && typeof capabilities.supports_vision !== 'boolean') {
      errors.push('Capability supports_vision must be boolean');
    }

    if (capabilities.context_window !== undefined) {
      if (typeof capabilities.context_window !== 'number') {
        errors.push('Capability context_window must be number');
      } else if (capabilities.context_window < 0) {
        errors.push('Capability context_window must be non-negative');
      }
    }

    if (capabilities.max_tokens !== undefined) {
      if (typeof capabilities.max_tokens !== 'number') {
        errors.push('Capability max_tokens must be number');
      } else if (capabilities.max_tokens < 0) {
        errors.push('Capability max_tokens must be non-negative');
      }
    }

    if (capabilities.features !== undefined && !Array.isArray(capabilities.features)) {
      errors.push('Capability features must be array');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate URL
   * @private
   * @param {string} url - URL to validate
   * @returns {boolean}
   */
  static _isValidUrl(url) {
    try {
      new URL(url);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Validate JSON string
   * @param {string} jsonString - JSON string to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateJSON(jsonString) {
    const errors = [];

    if (!jsonString) {
      errors.push('JSON string is required');
      return { valid: false, errors };
    }

    if (typeof jsonString !== 'string') {
      errors.push('JSON must be string');
      return { valid: false, errors };
    }

    try {
      JSON.parse(jsonString);
    } catch (error) {
      errors.push(`Invalid JSON: ${error.message}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

module.exports = { SettingsValidator };

