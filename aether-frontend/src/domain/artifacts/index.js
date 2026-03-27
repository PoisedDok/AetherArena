'use strict';

/**
 * @module domain/artifacts/index
 * 
 * Artifacts Domain
 * Public API for artifact management
 * 
 * Clean domain layer following DDD principles.
 * 
 * Re-exports: Artifact, ExecutionResult (models), ArtifactService,
 * TraceabilityService, ArtifactStreamHandler (services), ArtifactRepository (repositories),
 * ArtifactValidator (validators) for centralized import path.
 */

// Models
const { Artifact } = require('./models/Artifact');
const { ExecutionResult } = require('./models/ExecutionResult');

// Services
const { ArtifactService } = require('./services/ArtifactService');
const { TraceabilityService } = require('./services/TraceabilityService');
const { ArtifactStreamHandler } = require('./services/ArtifactStreamHandler');

// Repositories
const { ArtifactRepository } = require('./repositories/ArtifactRepository');

// Validators & Contracts
const { ArtifactValidator } = require('./validators/ArtifactValidator');
const {
  ARTIFACT_STREAM_SCHEMA,
  MAX_ARTIFACT_SIZE,
  normalizeArtifactStreamPayload,
  validateArtifactStreamPayload,
  resolvePhaseKindFromPayload,
  getArtifactVariantKey,
  enforceArtifactSizeLimit
} = require('./contracts/ArtifactStreamContract');

module.exports = {
  // Models
  Artifact,
  ExecutionResult,
  
  // Services
  ArtifactService,
  TraceabilityService,
  ArtifactStreamHandler,
  
  // Repositories
  ArtifactRepository,
  
  // Validators
  ArtifactValidator,

  // Contracts
  ARTIFACT_STREAM_SCHEMA,
  MAX_ARTIFACT_SIZE,
  normalizeArtifactStreamPayload,
  validateArtifactStreamPayload,
  resolvePhaseKindFromPayload,
  getArtifactVariantKey,
  enforceArtifactSizeLimit
};
