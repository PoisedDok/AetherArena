/**
 * Jest Configuration
 * ============================================================================
 * Production-grade Jest configuration for comprehensive testing:
 * - Unit tests with ≥85% coverage
 * - Integration tests
 * - Coverage thresholds enforced
 * - Multiple test environments (node, jsdom)
 * - Module path mapping
 * 
 * @module jest.config
 */

module.exports = {
  // Test environment
  testEnvironment: 'node',
  
  // Test match patterns
  testMatch: [
    '**/tests/unit/**/*.test.js',
    '**/tests/integration/**/*.test.js',
  ],
  
  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/',
  ],
  
  // Coverage configuration
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'text-summary',
    'lcov',
    'html',
    'json',
  ],
  
  // Coverage thresholds (Phase 12 requirements)
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 85,
      lines: 85,
      statements: 85,
    },
    // Critical paths require 100% coverage
    './src/core/security/**/*.js': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    './src/core/config/**/*.js': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    './src/core/di/**/*.js': {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
  
  // Files to collect coverage from
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!src/**/*.spec.js',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/build/**',
    '!**/coverage/**',
  ],
  
  // Setup files
  setupFilesAfterEnv: ['<rootDir>/tests/helpers/setup.js'],
  
  // Module name mapper (for absolute imports)
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@domain/(.*)$': '<rootDir>/src/domain/$1',
    '^@infrastructure/(.*)$': '<rootDir>/src/infrastructure/$1',
    '^@application/(.*)$': '<rootDir>/src/application/$1',
    '^@main/(.*)$': '<rootDir>/src/main/$1',
    '^@renderer/(.*)$': '<rootDir>/src/renderer/$1',
    '^@preload/(.*)$': '<rootDir>/src/preload/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
  },
  
  // Transform files (if using Babel/TypeScript)
  transform: {},
  
  // Global test timeout
  testTimeout: 10000,
  
  // Verbose output
  verbose: true,
  
  // Clear mocks between tests
  clearMocks: true,
  
  // Restore mocks between tests
  restoreMocks: true,
  
  // Reset mocks between tests
  resetMocks: true,
  
  // Projects for different test environments
  projects: [
    {
      displayName: 'unit:node',
      testEnvironment: 'node',
      testMatch: [
        '**/tests/unit/core/**/*.test.js',
        '**/tests/unit/domain/**/*.test.js',
        '**/tests/unit/infrastructure/**/*.test.js',
        '**/tests/unit/main/**/*.test.js',
      ],
    },
    {
      displayName: 'unit:jsdom',
      testEnvironment: 'jsdom',
      testMatch: [
        '**/tests/unit/renderer/**/*.test.js',
        '**/tests/unit/preload/**/*.test.js',
      ],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: [
        '**/tests/integration/**/*.test.js',
      ],
    },
  ],
  
  // Max workers for parallel testing
  maxWorkers: '50%',
  
  // Bail after first failure (optional, disable for full test suite)
  bail: false,
  
  // Notify on completion
  notify: false,
  
  // Error on deprecated API usage
  errorOnDeprecated: true,
};


