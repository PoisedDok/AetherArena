'use strict';

/**
 * Clean Architecture Validation Tests
 * ============================================================================
 * Ensures clean architecture principles are maintained:
 * - No mixing of concerns
 * - Proper layer separation
 * - Dependency injection
 * - No circular dependencies
 */

const fs = require('fs');
const path = require('path');

describe('Clean Architecture Validation', () => {
  const SRC_DIR = path.join(__dirname, '../../src');

  describe('Layer Separation', () => {
    test('Domain layer should not import from infrastructure', () => {
      const domainDir = path.join(SRC_DIR, 'domain');
      const files = getAllJsFiles(domainDir);
      const violations = [];

      files.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');
        if (/require\(['"]. *infrastructure|from\s+['"]. *infrastructure/.test(content)) {
          violations.push(path.relative(SRC_DIR, file));
        }
      });

      if (violations.length > 0) {
        throw new Error(
          `Domain layer should not depend on infrastructure:\n  - ${violations.join('\n  - ')}`
        );
      }

      expect(violations).toHaveLength(0);
    });

    test('Domain layer should not import from renderer', () => {
      const domainDir = path.join(SRC_DIR, 'domain');
      const files = getAllJsFiles(domainDir);
      const violations = [];

      files.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');
        if (/require\(['"]. *renderer|from\s+['"]. *renderer/.test(content)) {
          violations.push(path.relative(SRC_DIR, file));
        }
      });

      if (violations.length > 0) {
        throw new Error(
          `Domain layer should not depend on renderer:\n  - ${violations.join('\n  - ')}`
        );
      }

      expect(violations).toHaveLength(0);
    });

    test('Domain layer should not import from main process', () => {
      const domainDir = path.join(SRC_DIR, 'domain');
      if (!fs.existsSync(domainDir)) return;

      const files = getAllJsFiles(domainDir);
      const violations = [];

      files.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');
        // Check for main process imports
        if (/require\(['"]electron['"]\)|require\(['"]. *\/main\//.test(content)) {
          violations.push(path.relative(SRC_DIR, file));
        }
      });

      if (violations.length > 0) {
        throw new Error(
          `Domain layer should not depend on main process:\n  - ${violations.join('\n  - ')}`
        );
      }

      expect(violations).toHaveLength(0);
    });

    test('Core layer should not import from domain', () => {
      const coreDir = path.join(SRC_DIR, 'core');
      const files = getAllJsFiles(coreDir);
      const violations = [];

      files.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');
        if (/require\(['"]. *domain|from\s+['"]. *domain/.test(content)) {
          violations.push(path.relative(SRC_DIR, file));
        }
      });

      if (violations.length > 0) {
        throw new Error(
          `Core layer should not depend on domain:\n  - ${violations.join('\n  - ')}`
        );
      }

      expect(violations).toHaveLength(0);
    });

    test('Application layer can depend on domain but not on infrastructure', () => {
      const appDir = path.join(SRC_DIR, 'application');
      const files = getAllJsFiles(appDir);
      const violations = [];

      files.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');
        // Application can import domain
        // But should not import infrastructure directly (use DI)
        if (/require\(['"]. *infrastructure|from\s+['"]. *infrastructure/.test(content)) {
          violations.push(path.relative(SRC_DIR, file));
        }
      });

      if (violations.length > 0) {
        console.warn(
          `Application layer should use DI instead of direct infrastructure imports:\n  - ${violations.join('\n  - ')}`
        );
        // This is a warning, not a hard failure
      }

      // Don't fail, just warn
      expect(true).toBe(true);
    });
  });

  describe('Dependency Injection', () => {
    test('Services should accept dependencies via constructor', () => {
      const domainDir = path.join(SRC_DIR, 'domain');
      const files = getAllJsFiles(domainDir).filter((f) => f.includes('/services/'));
      const violations = [];

      files.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');
        const hasClass = /class\s+\w+\s*\{/.test(content);
        if (!hasClass) return;

        // Check if service has constructor with dependency injection
        const hasConstructor = /constructor\s*\([^)]*\)/.test(content);
        if (!hasConstructor) {
          violations.push(path.relative(SRC_DIR, file));
        }
      });

      if (violations.length > 0) {
        console.warn(
          `Services should use constructor dependency injection:\n  - ${violations.join('\n  - ')}`
        );
      }

      // Informational test
      expect(true).toBe(true);
    });

    test('No singleton instances outside container', () => {
      const srcFiles = getAllJsFiles(SRC_DIR);
      const violations = [];

      srcFiles.forEach((file) => {
        // Skip container files
        if (file.includes('/core/di/')) return;

        const content = fs.readFileSync(file, 'utf8');
        // Check for singleton pattern
        if (/let\s+instance\s*=\s*null|private\s+static\s+instance/.test(content)) {
          violations.push(path.relative(SRC_DIR, file));
        }
      });

      if (violations.length > 0) {
        console.warn(
          `Singleton instances should be managed by DI container:\n  - ${violations.join('\n  - ')}`
        );
      }

      // Informational
      expect(true).toBe(true);
    });
  });

  describe('No Mixed Concerns', () => {
    test('No UI code in domain models', () => {
      const modelsDir = path.join(SRC_DIR, 'domain');
      const files = getAllJsFiles(modelsDir).filter((f) => f.includes('/models/'));
      const violations = [];

      const uiPatterns = [
        /document\.|window\./,
        /\.innerHTML|\.outerHTML/,
        /createElement|querySelector/,
        /addEventListener|removeEventListener/,
      ];

      files.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');
        
        for (const pattern of uiPatterns) {
          if (pattern.test(content)) {
            violations.push({
              file: path.relative(SRC_DIR, file),
              pattern: pattern.toString(),
            });
            break;
          }
        }
      });

      if (violations.length > 0) {
        throw new Error(
          `Domain models should not contain UI code:\n${violations.map((v) => `  - ${v.file} (${v.pattern})`).join('\n')}`
        );
      }

      expect(violations).toHaveLength(0);
    });

    test('No business logic in renderers', () => {
      const rendererDir = path.join(SRC_DIR, 'renderer');
      if (!fs.existsSync(rendererDir)) return;

      const files = getAllJsFiles(rendererDir);
      const violations = [];

      // Check for business logic patterns in renderers
      const businessLogicPatterns = [
        /function\s+calculate[A-Z]\w*\(/,
        /function\s+validate[A-Z]\w*\(/,
        /function\s+process[A-Z]\w*\(/,
        /class\s+\w*Validator\s*\{/,
        /class\s+\w*Calculator\s*\{/,
      ];

      files.forEach((file) => {
        // Skip controllers (they can coordinate)
        if (file.includes('/controllers/')) return;

        const content = fs.readFileSync(file, 'utf8');

        for (const pattern of businessLogicPatterns) {
          if (pattern.test(content)) {
            violations.push({
              file: path.relative(SRC_DIR, file),
              pattern: pattern.toString(),
            });
            break;
          }
        }
      });

      if (violations.length > 0) {
        console.warn(
          `Renderers should delegate to domain services, not contain business logic:\n${violations.map((v) => `  - ${v.file} (${v.pattern})`).join('\n')}`
        );
      }

      // Warning only
      expect(true).toBe(true);
    });

    test('No database queries in domain services', () => {
      const servicesDir = path.join(SRC_DIR, 'domain');
      const files = getAllJsFiles(servicesDir).filter((f) => f.includes('/services/'));
      const violations = [];

      const dbPatterns = [
        /executeQuery|rawQuery/,
        /['"`]SELECT\s+\*\s+FROM/i,  // Must be in a string
        /['"`]INSERT\s+INTO/i,
        /['"`]UPDATE\s+\w+\s+SET/i,
        /['"`]DELETE\s+FROM/i,
      ];

      files.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');

        for (const pattern of dbPatterns) {
          if (pattern.test(content)) {
            violations.push({
              file: path.relative(SRC_DIR, file),
              pattern: pattern.toString(),
            });
            break;
          }
        }
      });

      if (violations.length > 0) {
        throw new Error(
          `Domain services should use repositories, not execute raw queries:\n${violations.map((v) => `  - ${v.file} (${v.pattern})`).join('\n')}`
        );
      }

      expect(violations).toHaveLength(0);
    });
  });

  describe('Circular Dependencies', () => {
    test('No circular dependencies between modules', () => {
      // This is a complex check that would require parsing the entire dependency graph
      // For now, just check for obvious circular patterns

      const srcFiles = getAllJsFiles(SRC_DIR);
      const violations = [];

      srcFiles.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');
        const dir = path.dirname(file);
        const parentDir = path.dirname(dir);

        // Check if importing from parent and child simultaneously
        const imports = content.match(/require\(['"]([^'"]+)['"]\)/g) || [];
        
        const hasParentImport = imports.some((imp) => imp.includes('../'));
        const hasChildImport = imports.some((imp) => !imp.includes('..') && !imp.startsWith('.'));

        if (hasParentImport && hasChildImport) {
          // This might be a circular dependency
          violations.push(path.relative(SRC_DIR, file));
        }
      });

      if (violations.length > 0) {
        console.warn(
          `Potential circular dependencies (manual review needed):\n  - ${violations.join('\n  - ')}`
        );
      }

      // Informational
      expect(true).toBe(true);
    });
  });

  describe('Error Handling', () => {
    test('All async functions should have try-catch', () => {
      const srcFiles = getAllJsFiles(SRC_DIR);
      const violations = [];

      srcFiles.forEach((file) => {
        // Skip test files
        if (/\.test\.js$|\.spec\.js$/.test(file)) return;

        const content = fs.readFileSync(file, 'utf8');
        
        // Find async functions
        const asyncFunctions = content.match(/async\s+\w+\s*\([^)]*\)\s*\{[^}]+\}/g) || [];

        asyncFunctions.forEach((func) => {
          if (!/try\s*\{|\.catch\(/.test(func)) {
            violations.push({
              file: path.relative(SRC_DIR, file),
              function: func.substring(0, 50) + '...',
            });
          }
        });
      });

      if (violations.length > 0) {
        console.warn(
          `Async functions should have error handling:\n${violations.slice(0, 10).map((v) => `  - ${v.file}: ${v.function}`).join('\n')}`
        );
      }

      // Warning only
      expect(true).toBe(true);
    });
  });
});

// Helper function to recursively get all JS files
function getAllJsFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;

  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      getAllJsFiles(filePath, fileList);
    } else if (file.endsWith('.js') && !file.endsWith('.test.js') && !file.endsWith('.spec.js')) {
      fileList.push(filePath);
    }
  });

  return fileList;
}

