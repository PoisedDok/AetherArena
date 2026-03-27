/**
 * @.architecture
 *
 * Incoming: core/di/Container.js --- {Class<DependencyContainer>, javascript_module}
 * Processing: Provide renderer-scoped DI container factory with optional logging --- {2 jobs: JOB_DELEGATE_TO_MODULE, JOB_INITIALIZE}
 * Outgoing: createRendererContainer(), RendererContainer export --- {Function, javascript_module}
 */

'use strict';

const { DependencyContainer } = require('../../../core/di/Container');

function createRendererContainer(options = {}) {
  return new DependencyContainer({
    name: options.name || 'renderer',
    enableLogging: options.enableLogging === true,
  });
}

module.exports = {
  createRendererContainer,
  RendererContainer: DependencyContainer,
};
