/**
 * @.architecture
 *
 * Incoming: core/communication/Endpoint.js --- {Class<Endpoint>, javascript_module}
 * Processing: Construct renderer-safe Endpoint instances with config guards --- {2 jobs: JOB_DELEGATE_TO_MODULE, JOB_VALIDATE_SCHEMA}
 * Outgoing: createRendererEndpoint(), RendererEndpoint export --- {Function | Class<Endpoint>, javascript_module}
 */

'use strict';

const Endpoint = require('../../../core/communication/Endpoint');

function createRendererEndpoint(config = {}) {
  if (!config.API_BASE_URL || !config.WS_URL) {
    throw new Error('[RendererEndpoint] API_BASE_URL and WS_URL are required');
  }
  return new Endpoint(config);
}

module.exports = {
  createRendererEndpoint,
  RendererEndpoint: Endpoint,
};
