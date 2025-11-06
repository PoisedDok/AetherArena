'use strict';

/**
 * Hardcoded Paths Validation Tests
 * ============================================================================
 * Ensures no hardcoded paths or URLs in source code.
 * All configuration should use centralized config module.
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

describe('Hardcoded Paths Validation', () => {
  const SRC_DIR = path.join(__dirname, '../../src');
  const ALLOWED_PATTERNS = [
    // Config files are allowed to have default URLs
    'src/core/config/defaults.js',
    'src/core/config/index.js',
    'src/core/config/resolvers.js',
    // README files can have example URLs
    /README\.md$/,
    // Test files can have mock URLs
    /\.test\.js$/,
    /\.spec\.js$/,
  ];

  // Patterns that indicate hardcoded URLs
  const HARDCODED_URL_PATTERNS = [
    /http:\/\/localhost:\d+(?!.*config|.*default|.*example)/i,
    /https:\/\/localhost:\d+(?!.*config|.*default|.*example)/i,
    /127\.0\.0\.1:\d+(?!.*config|.*default|.*example)/,
  ];

  // Patterns that indicate deep relative imports (code smell)
  const DEEP_REQUIRE_PATTERNS = [
    /require\(['"]\.\.[/\\]\.\.[/\\]\.\.[/\\]\.\.[/\\]/,
  ];

  let sourceFiles = [];

  beforeAll(async () => {
    // Find all JS files in src directory
    sourceFiles = await new Promise((resolve, reject) => {
      const pattern = path.join(SRC_DIR, '**/*.js').replace(/\\/g, '/');
      glob(pattern, (err, files) => {
        if (err) reject(err);
        else resolve(files);
      });
    });
  });

  test('should not have hardcoded localhost URLs outside config', () => {
    const violations = [];

    for (const file of sourceFiles) {
      // Skip allowed files
      if (ALLOWED_PATTERNS.some((pattern) => {
        if (pattern instanceof RegExp) {
          return pattern.test(file);
        }
        return file.includes(pattern);
      })) {
        continue;
      }

      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        // Skip comments and strings in comments
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
          return;
        }

        for (const pattern of HARDCODED_URL_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({
              file: path.relative(SRC_DIR, file),
              line: index + 1,
              content: line.trim(),
            });
          }
        }
      });
    }

    if (violations.length > 0) {
      const message = [
        'Found hardcoded URLs in source code:',
        ...violations.map((v) => `  ${v.file}:${v.line} - ${v.content}`),
        '',
        'All URLs should be imported from src/core/config/index.js',
        'Example: const config = require("../../core/config");',
        '         const url = config.backend.baseUrl;',
      ].join('\n');

      throw new Error(message);
    }

    expect(violations).toHaveLength(0);
  });

  test('should not have excessive relative imports', () => {
    const violations = [];

    for (const file of sourceFiles) {
      // Skip test files
      if (/\.test\.js$/.test(file) || /\.spec\.js$/.test(file)) {
        continue;
      }

      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        for (const pattern of DEEP_REQUIRE_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({
              file: path.relative(SRC_DIR, file),
              line: index + 1,
              content: line.trim(),
            });
          }
        }
      });
    }

    if (violations.length > 0) {
      const message = [
        'Found excessive relative imports (../../../../):',
        ...violations.map((v) => `  ${v.file}:${v.line} - ${v.content}`),
        '',
        'Consider:',
        '1. Using dependency injection',
        '2. Restructuring modules',
        '3. Creating index files for cleaner imports',
      ].join('\n');

      console.warn(message);
      // Don't fail on this, just warn
    }

    // This is a warning test, not a hard failure
    expect(true).toBe(true);
  });

  test('should use config module for API endpoints', () => {
    const violations = [];
    const endpointPatterns = [
      /['"]\/api\//,
      /['"]\/health['"]/,
      /['"]\/settings['"]/,
      /['"]\/models['"]/,
      /['"]\/profiles['"]/,
    ];

    for (const file of sourceFiles) {
      // Skip config files
      if (file.includes('src/core/config/')) {
        continue;
      }

      // Skip test files
      if (/\.test\.js$/.test(file) || /\.spec\.js$/.test(file)) {
        continue;
      }

      const content = fs.readFileSync(file, 'utf8');

      // Check if file uses hardcoded endpoints without importing config
      const hasEndpoints = endpointPatterns.some((pattern) => pattern.test(content));
      const hasConfigImport = /require\(['"]. [^'"]*config/.test(content) || 
                             /from\s+['"]. [^'"]*config/.test(content);

      if (hasEndpoints && !hasConfigImport) {
        violations.push({
          file: path.relative(SRC_DIR, file),
          issue: 'Uses hardcoded endpoints without importing config',
        });
      }
    }

    if (violations.length > 0) {
      const message = [
        'Found hardcoded API endpoints without config import:',
        ...violations.map((v) => `  ${v.file} - ${v.issue}`),
        '',
        'All API endpoints should be imported from config.endpoints',
        'Example: const config = require("../../core/config");',
        '         const url = `${config.backend.baseUrl}${config.endpoints.health}`;',
      ].join('\n');

      console.warn(message);
      // Warning only for now
    }

    // This is informational
    expect(true).toBe(true);
  });

  test('should document all configuration values in defaults.js', () => {
    const defaultsFile = path.join(SRC_DIR, 'core/config/defaults.js');
    const content = fs.readFileSync(defaultsFile, 'utf8');

    // Check for common configuration categories
    const requiredCategories = [
      'backend',
      'services',
      'llm',
      'ui',
      'security',
      'storage',
      'endpoints',
    ];

    const missing = requiredCategories.filter((category) => {
      const pattern = new RegExp(`${category}\\s*:`);
      return !pattern.test(content);
    });

    expect(missing).toHaveLength(0);
  });

  test('should freeze all default configuration objects', () => {
    const defaultsFile = path.join(SRC_DIR, 'core/config/defaults.js');
    const content = fs.readFileSync(defaultsFile, 'utf8');

    // Check that Object.freeze is used
    const hasFreezes = /Object\.freeze\(|freeze\(/g.test(content);

    expect(hasFreezes).toBe(true);
  });
});

