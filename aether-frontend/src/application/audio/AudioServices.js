'use strict';

/**
 * @.architecture
 *
 * Incoming: Presentation layer requesting audio services --- {eventBus, endpoint, config}
 * Processing: Create domain audio services behind application boundary --- {2 jobs: JOB_CREATE_INSTANCE, JOB_DELEGATE_TO_MODULE}
 * Outgoing: AudioManager, HandsfreeCoordinator instances --- {object, javascript_api}
 *
 * @module application/audio/AudioServices
 */

const { AudioManager } = require('../../domain/audio/services/AudioManager');
const { AudioConfig } = require('../../domain/audio/models/AudioConfig');
const { HandsfreeCoordinator } = require('../../domain/audio/services/HandsfreeCoordinator');
const { createRendererLogger } = require('../../renderer/shared/utils/logger');

class AudioServices {
  createDefaultConfig() {
    return AudioConfig.createDefault();
  }

  createAudioManager({ eventBus, endpoint, config }) {
    if (!config) {
      throw new Error('[AudioServices] config is required to create AudioManager');
    }
    return new AudioManager({
      eventBus,
      endpoint,
      config,
    });
  }

  createHandsfreeCoordinator({ audioManager, eventBus, endpoint, config }) {
    if (!audioManager) {
      throw new Error('[AudioServices] audioManager is required to create HandsfreeCoordinator');
    }
    return new HandsfreeCoordinator({
      audioManager,
      eventBus,
      endpoint,
      config,
      log: createRendererLogger('HandsfreeCoordinator'),
    });
  }
}

module.exports = { AudioServices };
