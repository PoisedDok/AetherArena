'use strict';

/**
 * @module application/main/index
 * 
 * Main Window Application Services
 * ============================================================================
 * Application layer services for the main window renderer.
 * 
 * Re-exports MainOrchestrator for centralized import path.
 */

const { MainOrchestrator } = require('./MainOrchestrator');

module.exports = {
  MainOrchestrator
};
