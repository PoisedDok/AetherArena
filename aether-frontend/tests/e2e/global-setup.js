/**
 * Playwright Global Setup
 * ============================================================================
 * Global setup for E2E tests
 * 
 * @module tests/e2e/global-setup
 */

module.exports = async function globalSetup() {
  console.log('🚀 Setting up E2E test environment...');
  
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.ELECTRON_DEV = 'false';
  
  // Clean up test data directory
  // await cleanTestData();
  
  console.log('✅ E2E test environment ready');
};


