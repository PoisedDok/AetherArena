'use strict';

/**
 * @.architecture
 *
 * Incoming: Presentation layer requesting artifact services --- {storageAPI, logger, systemAPI}
 * Processing: Compose domain + infrastructure services behind application boundary --- {5 jobs: JOB_INITIALIZE, JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_VALIDATE_SCHEMA, JOB_CREATE_INSTANCE}
 * Outgoing: ArtifactService/Cache/IndexService, validators, formatters, router --- {object, javascript_api}
 *
 * @module application/artifacts/ArtifactsServices
 */

const { ArtifactService } = require('../../domain/artifacts/services/ArtifactService');
const { ArtifactRepository } = require('../../domain/artifacts/repositories/ArtifactRepository');
const { CodeExecutionValidator } = require('../../domain/artifacts/validators/CodeExecutionValidator');
const { FileExportValidator } = require('../../domain/artifacts/validators/FileExportValidator');
const { ExecutionResultFormatter } = require('../../domain/artifacts/services/ExecutionResultFormatter');
const { ArtifactRouter } = require('../../domain/artifacts/services/ArtifactRouter');
const { ArtifactEnricher } = require('../../domain/artifacts/services/ArtifactEnricher');
const { ArtifactCache } = require('../../domain/artifacts/state/ArtifactCache');
const { ArtifactIndexService } = require('../../domain/artifacts/services/ArtifactIndexService');
const { BackendHealthProbe } = require('../../infrastructure/monitoring/BackendHealthProbe');

class ArtifactsServices {
  constructor(options = {}) {
    const storageAPI = options.storageAPI;
    const logger = options.logger;
    const systemAPI = options.systemAPI || null;
    const cacheOptions = options.cacheOptions || {};

    this.artifactRepository = options.artifactRepository || new ArtifactRepository({
      storageAPI,
      logger,
    });

    this.artifactService = options.artifactService || new ArtifactService({
      repository: this.artifactRepository,
      logger,
    });

    this.artifactCache = options.artifactCache || new ArtifactCache(cacheOptions);
    this.artifactIndexService = options.artifactIndexService || new ArtifactIndexService();

    this.backendHealthProbe = options.backendHealthProbe || new BackendHealthProbe({
      storageAPI,
      systemAPI,
    });
  }
}

module.exports = {
  ArtifactsServices,
  CodeExecutionValidator,
  FileExportValidator,
  ExecutionResultFormatter,
  ArtifactRouter,
  ArtifactEnricher,
};
