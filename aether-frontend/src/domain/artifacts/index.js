'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export Artifact/ExecutionResult (models), ArtifactService/ExecutionService/TraceabilityService/ArtifactStreamHandler (services), ArtifactRepository (repositories), ArtifactValidator (validators) for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: application/*, renderer/* (artifacts domain layer) --- {module_exports, javascript_object}
 * 
 * 
 * @module domain/artifacts/index
 * 
 * Artifacts Domain
 * Public API for artifact management
 * 
 * Clean domain layer following DDD principles
 */

// Models
const { Artifact } = require('./models/Artifact');
const { ExecutionResult } = require('./models/ExecutionResult');

// Services
const { ArtifactService } = require('./services/ArtifactService');
const { ExecutionService } = require('./services/ExecutionService');
const { TraceabilityService } = require('./services/TraceabilityService');
const { ArtifactStreamHandler } = require('./services/ArtifactStreamHandler');

// Repositories
const { ArtifactRepository } = require('./repositories/ArtifactRepository');

// Validators
const { ArtifactValidator } = require('./validators/ArtifactValidator');

module.exports = {
  // Models
  Artifact,
  ExecutionResult,
  
  // Services
  ArtifactService,
  ExecutionService,
  TraceabilityService,
  ArtifactStreamHandler,
  
  // Repositories
  ArtifactRepository,
  
  // Validators
  ArtifactValidator
};

