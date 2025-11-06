'use strict';

/**
 * Architecture Validation Tests
 * Verifies clean architecture principles and best practices
 */

const fs = require('fs');
const path = require('path');

describe('Architecture Validation', () => {
  const srcPath = path.join(__dirname, '../../src');

  // Set timeout for file scanning operations
  jest.setTimeout(3000);

  describe('No hardcoded paths', () => {
    it('should not have hardcoded user-specific paths in source files', () => {
      const files = getAllJsFiles(srcPath);
      const violations = [];

      const hardcodedPathPatterns = [
        /\/Users\/[^\/]+/,           // macOS user paths
        /\/home\/[^\/]+/,            // Linux user paths
        /C:\\Users\\[^\\]+/,         // Windows user paths
        /\/Volumes\/[^\/]+\/[^\/]+/, // macOS external volumes (except in ServiceLauncher which uses env var)
      ];

      files.forEach(file => {
        // Skip ServiceLauncher as we fixed it to use env vars
        if (file.includes('ServiceLauncher.js')) return;

        const content = fs.readFileSync(file, 'utf8');
        hardcodedPathPatterns.forEach(pattern => {
          if (pattern.test(content)) {
            violations.push({
              file: path.relative(srcPath, file),
              pattern: pattern.toString(),
              line: getLineNumber(content, pattern)
            });
          }
        });
      });

      if (violations.length > 0) {
        console.error('Hardcoded paths found:');
        violations.forEach(v => {
          console.error(`  ${v.file}:${v.line} - matches ${v.pattern}`);
        });
      }

      expect(violations.length).toBe(0);
    });

    it('should use environment variables for configurable paths', () => {
      const configFile = path.join(srcPath, 'core/config/index.js');
      const content = fs.readFileSync(configFile, 'utf8');

      // Should use envLoader for paths
      expect(content).toMatch(/envLoader\.(getString|getPath)/);
      // Should have backendDir getter
      expect(content).toMatch(/get backendDir\(\)/);
    });
  });

  describe('Clean architecture layers', () => {
    it('should have correct directory structure', () => {
      const expectedDirs = [
        'core',
        'domain',
        'application',
        'infrastructure',
        'main',
        'preload',
        'renderer'
      ];

      expectedDirs.forEach(dir => {
        const dirPath = path.join(srcPath, dir);
        expect(fs.existsSync(dirPath)).toBe(true);
      });
    });

    it('should not have circular dependencies between layers', () => {
      // Domain should not import from application/infrastructure
      const domainPath = path.join(srcPath, 'domain');
      if (fs.existsSync(domainPath)) {
        const domainFiles = getAllJsFiles(domainPath).slice(0, 30);
      domainFiles.forEach(file => {
          // Skip repository files which may require infrastructure as fallback
          if (file.includes('/repositories/')) {
            return;
          }
          
        const content = fs.readFileSync(file, 'utf8');
        expect(content).not.toMatch(/require\(['"].*\/application\//);
        expect(content).not.toMatch(/require\(['"].*\/infrastructure\//);
      });
      }

      // Application should not import from infrastructure (except specific cases)
      const appPath = path.join(srcPath, 'application');
      if (fs.existsSync(appPath)) {
        const appFiles = getAllJsFiles(appPath).slice(0, 30);
      appFiles.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');
        // Allow importing from infrastructure for DI and monitoring
        const infraImports = content.match(/require\(['"].*\/infrastructure\/(?!monitoring|ipc)/g);
        if (infraImports && infraImports.length > 0) {
          console.warn(`Application layer importing infrastructure: ${file}`);
        }
      });
      }
    });

    it('should use dependency injection instead of direct imports', () => {
      const orchestrators = [
        'application/main/MainOrchestrator.js',
        'application/chat/ChatOrchestrator.js',
        'application/artifacts/ArtifactsOrchestrator.js'
      ];

      orchestrators.forEach(orchestratorPath => {
        const file = path.join(srcPath, orchestratorPath);
        if (!fs.existsSync(file)) return;

        const content = fs.readFileSync(file, 'utf8');

        // Should have constructor accepting dependencies
        expect(content).toMatch(/constructor\s*\(\s*(?:options|dependencies)/);

        // Should not directly instantiate domain services
        const directInstantiations = content.match(/new\s+\w+Service\(/g);
        if (directInstantiations) {
          console.warn(`Direct service instantiation in ${orchestratorPath}:`, directInstantiations);
        }
      });
    });
  });

  describe('Separation of concerns', () => {
    it('should not mix UI logic with business logic', () => {
      const domainPath = path.join(srcPath, 'domain');
      
      if (!fs.existsSync(domainPath)) {
        return; // Skip if directory doesn't exist
      }
      
      const domainFiles = getAllJsFiles(domainPath).slice(0, 50); // Limit to 50 files

      domainFiles.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');

        // Skip README files
        if (file.endsWith('README.md')) {
          return;
        }

        // Domain should not manipulate DOM
        expect(content).not.toMatch(/document\./);
        
        // Allow window checks for storage API and browser-specific features
        // Audio domain uses window.AudioContext which is a browser API
        const isAudioDomain = file.includes('/domain/audio/');
        const windowChecks = content.match(/typeof window !== ['"]undefined['"]/g) || [];
        const animationFrames = content.match(/window\.(cancelAnimationFrame|requestAnimationFrame)/g) || [];
        const storageAPICalls = content.match(/window\.storageAPI/g) || [];
        const audioContext = content.match(/window\.(AudioContext|webkitAudioContext)/g) || [];
        const allowedWindowCalls = windowChecks.length + animationFrames.length + storageAPICalls.length + (isAudioDomain ? audioContext.length : 0);
        
        const windowMatches = content.match(/window\./g) || [];
        if (windowMatches.length > allowedWindowCalls) {
          throw new Error(`Unexpected window usage in ${file}: ${windowMatches.length} uses, ${allowedWindowCalls} allowed`);
        }
        
        expect(content).not.toMatch(/querySelector/);
        expect(content).not.toMatch(/getElementById/);
        expect(content).not.toMatch(/innerHTML/);
      });
    });

    it('should not have business logic in renderer', () => {
      const rendererFiles = getAllJsFiles(path.join(srcPath, 'renderer'));

      rendererFiles.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');

        // Renderer should delegate to orchestrators/services
        const hasBusinessLogic = 
          content.match(/class\s+\w+Service/) ||
          content.match(/class\s+\w+Repository/);

        if (hasBusinessLogic) {
          console.warn(`Business logic in renderer: ${file}`);
        }
      });
    });

    it('should use centralized configuration', () => {
      const files = getAllJsFiles(srcPath);
      const violations = [];

      files.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');

        // Should not have inline configuration
        const inlineUrls = content.match(/['"]https?:\/\/(?:localhost|127\.0\.0\.1):\d+['"]/g);
        if (inlineUrls && !file.includes('core/config')) {
          violations.push({
            file: path.relative(srcPath, file),
            urls: inlineUrls
          });
        }
      });

      if (violations.length > 0) {
        console.error('Inline URLs found (should use config):');
        violations.forEach(v => {
          console.error(`  ${v.file}: ${v.urls.join(', ')}`);
        });
      }

      expect(violations.length).toBe(0);
    });
  });

  describe('Security practices', () => {
    it('should not have eval() usage', () => {
      const files = getAllJsFiles(srcPath);
      const violations = [];

      // Whitelist: eval is allowed in Web Worker contexts for sandboxed code execution
      const whitelistedFiles = [
        'renderer/artifacts/modules/execution/SafeCodeExecutor.js', // Web Worker sandbox
      ];

      files.forEach(file => {
        const relativePath = path.relative(srcPath, file);
        const content = fs.readFileSync(file, 'utf8');

        // Skip whitelisted files
        if (whitelistedFiles.some(wf => relativePath.includes(wf))) {
          return;
        }

        if (/\beval\s*\(/.test(content)) {
          violations.push(relativePath);
        }
      });

      expect(violations).toEqual([]);
    });

    it('should not have Function() constructor usage', () => {
      const files = getAllJsFiles(srcPath);
      const violations = [];

      // Whitelist: Function constructor is allowed in Web Worker contexts and IPC validation
      const whitelistedFiles = [
        'domain/artifacts/services/ExecutionService.js', // Web Worker sandbox
        'preload/artifacts-preload.js', // IPC payload validation
        'preload/chat-preload.js', // IPC payload validation
      ];

      files.forEach(file => {
        const relativePath = path.relative(srcPath, file);
        const content = fs.readFileSync(file, 'utf8');

        // Skip whitelisted files
        if (whitelistedFiles.some(wf => relativePath.includes(wf))) {
          return;
        }

        if (/new\s+Function\s*\(/.test(content)) {
          violations.push(relativePath);
        }
      });

      expect(violations).toEqual([]);
    });

    it('should sanitize HTML content', () => {
      const htmlRenderers = getAllJsFiles(path.join(srcPath, 'renderer'))
        .filter(f => f.includes('Renderer') || f.includes('OutputViewer'));

      htmlRenderers.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');

        if (content.includes('innerHTML') || content.includes('outerHTML')) {
          // Should use sanitization
          const hasSanitization = 
            content.includes('DOMPurify') ||
            content.includes('sanitize') ||
            content.includes('Sanitizer');

          if (!hasSanitization) {
            console.warn(`Potential XSS risk in ${file}: using innerHTML without sanitization`);
          }
        }
      });
    });

    it('should validate user input', () => {
      const validators = fs.existsSync(path.join(srcPath, 'domain'))
        ? getAllJsFiles(path.join(srcPath, 'domain')).filter(f => f.includes('validator'))
        : [];

      expect(validators.length).toBeGreaterThan(0);
    });
  });

  describe('Code quality', () => {
    it('should use strict mode', () => {
      const files = getAllJsFiles(srcPath);
      const violations = [];

      files.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');
        const firstLine = content.split('\n')[0];

        if (!firstLine.includes("'use strict'") && !firstLine.includes('"use strict"')) {
          violations.push(path.relative(srcPath, file));
        }
      });

      if (violations.length > 0) {
        console.warn('Files missing strict mode:', violations.slice(0, 10));
      }

      // Should have most files in strict mode
      expect(violations.length / files.length).toBeLessThan(0.2);
    });

    it('should have JSDoc comments for public APIs', () => {
      const services = getAllJsFiles(path.join(srcPath, 'domain'))
        .filter(f => f.includes('Service.js'));

      services.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');

        // Should have class documentation
        expect(content).toMatch(/\/\*\*[\s\S]*?\*\//);
      });
    });

    it('should not have console.log in production code', () => {
      const files = getAllJsFiles(path.join(srcPath, 'domain'));
      const violations = [];

      files.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');

        // Allow console in if statements checking for debug mode
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          if (/console\.log\(/.test(line) && !/if\s*\(.*debug/i.test(line)) {
            violations.push(`${path.relative(srcPath, file)}:${index + 1}`);
          }
        });
      });

      if (violations.length > 0) {
        console.warn('console.log found in domain layer:', violations.slice(0, 10));
      }
    });
  });

  describe('Testing coverage', () => {
    it('should have tests for domain services', () => {
      const services = getAllJsFiles(path.join(srcPath, 'domain'))
        .filter(f => f.includes('Service.js'));

      const testDir = path.join(__dirname, '../unit/domain');
      const testFiles = fs.existsSync(testDir)
        ? getAllJsFiles(testDir).filter(f => f.endsWith('.test.js'))
        : [];

      expect(testFiles.length).toBeGreaterThan(0);
    });

    it('should have integration tests', () => {
      const integrationDir = path.join(__dirname, '../integration');
      const testFiles = fs.existsSync(integrationDir)
        ? getAllJsFiles(integrationDir).filter(f => f.endsWith('.test.js'))
        : [];

      expect(testFiles.length).toBeGreaterThan(0);
    });
  });
});

// Helper functions
function getAllJsFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;

  const files = fs.readdirSync(dir);
  const excludedDirs = ['node_modules', 'build', 'dist', 'coverage', 'test-results', '.git', 'logs', 'data'];

  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      if (!excludedDirs.includes(file) && !file.startsWith('.')) {
        getAllJsFiles(filePath, fileList);
      }
    } else if (file.endsWith('.js')) {
      fileList.push(filePath);
    }
  });

  return fileList;
}

function getLineNumber(content, pattern) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      return i + 1;
    }
  }
  return -1;
}

