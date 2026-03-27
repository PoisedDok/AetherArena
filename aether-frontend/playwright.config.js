/**
 * Playwright E2E Testing Configuration
 * ============================================================================
 * Production-grade E2E testing configuration for Phase 12
 * Tests on macOS, Windows, and Linux
 * 
 * @module playwright.config
 */

const { devices } = require('@playwright/test');

module.exports = {
  // Test directory
  testDir: './tests/e2e',
  
  // Test timeout
  timeout: 30000,
  
  // Expect timeout
  expect: {
    timeout: 5000,
  },
  
  // Fail fast
  fullyParallel: true,
  
  // Retry failed tests
  retries: process.env.CI ? 2 : 0,
  
  // Number of workers
  workers: process.env.CI ? 1 : undefined,
  
  // Reporter configuration
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/playwright-report' }],
    ['json', { outputFile: 'test-results/playwright-results.json' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  
  // Shared settings for all projects
  use: {
    // Base URL (for Electron app)
    baseURL: 'file://',
    
    // Collect trace on failure
    trace: 'on-first-retry',
    
    // Screenshot on failure
    screenshot: 'only-on-failure',
    
    // Video on failure
    video: 'retain-on-failure',
    
    // Action timeout
    actionTimeout: 10000,
    
    // Navigation timeout
    navigationTimeout: 30000,
  },
  
  // Test projects for different platforms
  projects: [
    {
      name: 'macos',
      use: {
        ...devices['Desktop macOS'],
        platform: 'darwin',
      },
      testIgnore: /.*\.win\.spec\.js|.*\.linux\.spec\.js/,
    },
    {
      name: 'windows',
      use: {
        ...devices['Desktop Windows'],
        platform: 'win32',
      },
      testIgnore: /.*\.mac\.spec\.js|.*\.linux\.spec\.js/,
    },
    {
      name: 'linux',
      use: {
        ...devices['Desktop Linux'],
        platform: 'linux',
      },
      testIgnore: /.*\.mac\.spec\.js|.*\.win\.spec\.js/,
    },
  ],
  
  // Global setup/teardown
  globalSetup: require.resolve('./tests/e2e/global-setup.js'),
  globalTeardown: require.resolve('./tests/e2e/global-teardown.js'),
  
  // Output directory
  outputDir: 'test-results/playwright-output',
  
  // Preserve output on failure
  preserveOutput: 'failures-only',
  
  // Web server (if needed for renderer tests)
  // webServer: {
  //   command: 'npm run dev',
  //   port: 3000,
  //   timeout: 120000,
  //   reuseExistingServer: !process.env.CI,
  // },
};


