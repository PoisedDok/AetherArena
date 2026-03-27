/**
 * @.architecture
 *
 * Incoming: core/events/EventBus.js, core/events/EventTypes.js --- {Class<EventBus> | Dict, javascript_module}
 * Processing: Provide renderer-scoped EventBus factory and export canonical enums --- {2 jobs: JOB_DELEGATE_TO_MODULE, JOB_INITIALIZE}
 * Outgoing: createRendererEventBus(), RendererEventTypes, RendererEventPriority --- {Function | Dict, javascript_module}
 */

'use strict';

const EventBus = require('../../../core/events/EventBus');
const { EventTypes, EventPriority } = require('../../../core/events/EventTypes');

function createRendererEventBus(options = {}) {
  return new EventBus({
    name: options.name || 'renderer',
    maxListeners: options.maxListeners ?? 50,
    enableLogging: options.enableLogging === true,
  });
}

module.exports = {
  createRendererEventBus,
  RendererEventBus: EventBus,
  RendererEventTypes: EventTypes,
  RendererEventPriority: EventPriority,
};
