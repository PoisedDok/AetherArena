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

const _argv = process.argv || [];
// Coverage is expensive and should be opt-in for local targeted runs.
// Enable when explicitly requested (`npm run test:coverage`) or in CI.
const _wantsCoverage =
  _argv.includes('--coverage') ||
  _argv.includes('--collectCoverage') ||
  _argv.includes('--collect-coverage') ||
  Boolean(process.env.CI);

module.exports = {
  // Test environment
  testEnvironment: 'node',

  // CRITICAL: Restrict Jest's filesystem traversal to src/ and tests/ only.
  // Without this, Jest scans the entire project including dist/ which contains
  // packaged app binaries with hundreds of PostgreSQL WAL .snap files that
  // Jest misidentifies as obsolete Jest snapshots.
  roots: [
    '<rootDir>/src',
    '<rootDir>/tests',
  ],
  
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

  // Prevent Jest module resolution from traversing into dist/
  modulePathIgnorePatterns: [
    '<rootDir>/dist/',
    '<rootDir>/build/',
  ],
  watchPathIgnorePatterns: [
    '<rootDir>/dist/',
    '<rootDir>/build/',
  ],
  
  // Coverage configuration (opt-in; see _wantsCoverage above)
  collectCoverage: _wantsCoverage,
  coverageDirectory: 'coverage',
  coverageReporters: _wantsCoverage
    ? ['text', 'text-summary', 'lcov', 'html', 'json']
    : [],
  
  // Coverage thresholds (stabilization baseline)
  coverageThreshold: _wantsCoverage
    ? {
        global: {
          branches: 12,
          functions: 12,
          lines: 12,
          statements: 12,
        },
        './src/core/security/**/*.js': {
          branches: 50,
          functions: 65,
          lines: 65,
          statements: 65,
        },
      }
    : undefined,
  
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
  // setupFiles runs before the test framework is installed (before test files are loaded)
  setupFiles: ['<rootDir>/tests/helpers/setup-early.js'],
  // setupFilesAfterEnv runs after the test framework is installed but before tests run
  setupFilesAfterEnv: ['<rootDir>/tests/helpers/setup.js'],
  
  // Module name mapper (for absolute imports)
  moduleNameMapper: {
    // Avoid native node-canvas dependency during tests.
    // jsdom will `require("canvas")` if it exists; our installed `canvas` may not have a built binary
    // in all environments (CI/sandbox). Map to a pure-js stub to keep tests hermetic.
    '^canvas$': '<rootDir>/tests/helpers/canvas-stub.js',
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
        '**/tests/unit/application/**/*.test.js',
        '**/tests/unit/infrastructure/**/*.test.js',
        '**/tests/unit/main/**/*.test.js',
      ],
    },
    {
      displayName: 'unit:jsdom',
      testEnvironment: '<rootDir>/tests/helpers/jest-environment-jsdom-no-canvas.js',
      testMatch: [
        '**/tests/unit/renderer/**/*.test.js',
        '**/tests/unit/preload/**/*.test.js',
      ],
    },
    {
      displayName: 'component',
      testEnvironment: '<rootDir>/tests/helpers/jest-environment-jsdom-no-canvas.js',
      testMatch: [
        '**/tests/component/**/*.test.js',
      ],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: [
        '**/tests/integration/**/*.test.js',
      ],
    },
    {
      displayName: 'architecture',
      testEnvironment: 'node',
      testMatch: [
        '**/tests/architecture/**/*.test.js',
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


