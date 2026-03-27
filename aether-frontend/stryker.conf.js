/**
 * Stryker Mutation Testing Configuration
 * ============================================================================
 * Production-grade mutation testing for Phase 12
 * Target: ≥60% mutation score
 * 
 * @module stryker.conf
 */

module.exports = {
  // Mutation testing framework
  mutator: 'javascript',
  
  // Package manager
  packageManager: 'npm',
  
  // Test runner
  testRunner: 'jest',
  
  // Coverage analysis strategy
  coverageAnalysis: 'perTest',
  
  // Files to mutate
  mutate: [
    'src/core/**/*.js',
    'src/domain/**/*.js',
    'src/infrastructure/**/*.js',
    'src/main/**/*.js',
    'src/application/**/*.js',
    '!src/**/*.test.js',
    '!src/**/*.spec.js',
    '!**/__tests__/**',
    '!**/node_modules/**',
  ],
  
  // Test files
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    config: require('./jest.config.js'),
    enableFindRelatedTests: true,
  },
  
  // Mutation thresholds (Phase 12 requirement: ≥60%)
  thresholds: {
    high: 80,     // Green: >80%
    low: 60,      // Orange: 60-80%
    break: 60,    // Red: <60% - build fails
  },
  
  // Mutation operators
  mutators: {
    Arithmetic: true,
    ArrayDeclaration: true,
    ArrowFunction: true,
    Block: true,
    BooleanLiteral: true,
    ConditionalExpression: true,
    EqualityOperator: true,
    LogicalOperator: true,
    MethodExpression: true,
    ObjectLiteral: true,
    OptionalChaining: true,
    Regex: true,
    StringLiteral: true,
    UnaryOperator: true,
    UpdateOperator: true,
  },
  
  // Reporters
  reporters: [
    'html',
    'clear-text',
    'progress',
    'dashboard',
  ],
  
  // HTML reporter configuration
  htmlReporter: {
    baseDir: 'reports/mutation',
  },
  
  // Dashboard reporter (optional, requires Stryker Dashboard account)
  dashboard: {
    project: 'github.com/aether/aether-desktop',
    version: process.env.GITHUB_SHA || 'local',
  },
  
  // Concurrency
  concurrency: 4,
  
  // Timeout settings
  timeoutMS: 60000,
  timeoutFactor: 1.5,
  
  // Warnings
  warnings: {
    slow: true,
    unknown: false,
  },
  
  // Ignore patterns
  ignorePatterns: [
    'node_modules',
    'dist',
    'build',
    'coverage',
    'reports',
    '*.test.js',
    '*.spec.js',
  ],
  
  // Incremental mode (faster subsequent runs)
  incremental: true,
  incrementalFile: '.stryker-tmp/incremental.json',
  
  // Temp directory
  tempDirName: '.stryker-tmp',
  
  // Clean temp directory after run
  cleanTempDir: true,
  
  // Allow console output
  allowConsoleColors: true,
  
  // Log level
  logLevel: 'info',
  
  // File logging
  fileLogLevel: 'off',
  
  // Maximum concurrent test runners
  maxConcurrentTestRunners: 4,
  
  // Dry run timeout
  dryRunTimeoutMinutes: 5,
  
  // Plugins
  plugins: [
    '@stryker-mutator/core',
    '@stryker-mutator/javascript-mutator',
    '@stryker-mutator/jest-runner',
  ],
};


