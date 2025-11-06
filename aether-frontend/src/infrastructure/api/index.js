'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export StorageAPI for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: infrastructure/* (StorageAPI) --- {module_exports, javascript_object}
 * 
 * 
 * @module infrastructure/api/index
 * 
 * API Infrastructure - External API Clients
 * ============================================================================
 * Centralized exports for all backend API clients.
 * 
 * Frontend ONLY communicates with aether-backend API.
 * Backend services (Perplexica, Docling, XLWings) are accessed through
 * aether-backend endpoints, NOT directly from frontend.
 * 
 * @module infrastructure/api
 */

const { StorageAPI } = require('./storage');

module.exports = {
  StorageAPI
};

