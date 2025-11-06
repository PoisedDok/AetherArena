'use strict';

/**
 * Electron Main Entry Point
 * ============================================================================
 * Root entry point for Electron main process.
 * Delegates to modular main process implementation.
 * 
 * This file should remain minimal - all logic is in src/main/
 */

// Delegate to modular main process
require('./src/main/index.js');

