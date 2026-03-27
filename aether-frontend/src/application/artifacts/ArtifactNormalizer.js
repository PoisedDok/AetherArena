'use strict';

/**
 * @.architecture
 *
 * Incoming: Presentation layer file payloads --- {artifact_payload, json}
 * Processing: Delegate to domain normalizer behind application boundary --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: Normalized artifact payload --- {artifact_payload, json}
 *
 * @module application/artifacts/ArtifactNormalizer
 */

const { normalizeArtifactPayload } = require('../../domain/artifacts/utils/ArtifactNormalizer');

module.exports = {
  normalizeArtifactPayload,
};
