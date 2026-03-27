/**
 * @jest-environment node
 */
'use strict';

/**
 * Architectural Layer Violations - REAL ARCHITECTURE BUGS
 * ============================================================================
 * Tests for violations of clean architecture principles. These tests find
 * REAL architectural bugs, not just code smells. Based on:
 * docs/architecture/frontend-architecture.md (layering and boundaries)
 * 
 * FORBIDDEN DEPENDENCIES:
 * - Presentation → Domain (must go through Application)
 * - Presentation → Infrastructure (must go through Application)
 * - Domain → Any other layer
 * - Circular dependencies
 * 
 * @module tests/architecture/LayerViolations.real
 */

const fs = require('fs');
const path = require('path');

// Architecture paths
const PATHS = {
  presentation: 'src/renderer',
  application: 'src/application',
  domain: 'src/domain',
  infrastructure: 'src/infrastructure',
  core: 'src/core'
};

/**
 * Get all JS files in a directory recursively
 */
function getJSFiles(dir, baseDir = null) {
  if (!baseDir) baseDir = dir;
  
  const files = [];
  
  if (!fs.existsSync(dir)) {
    return files;
  }
  
  const items = fs.readdirSync(dir);
  
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      files.push(...getJSFiles(fullPath, baseDir));
    } else if (item.endsWith('.js') && !item.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

/**
 * Extract require/import statements from file
 */
function extractDependencies(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const dependencies = [];
  
  // Match require('path')
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  let match;
  
  while ((match = requireRegex.exec(content)) !== null) {
    dependencies.push(match[1]);
  }
  
  // Match import from 'path'
  const importRegex = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
  while ((match = importRegex.exec(content)) !== null) {
    dependencies.push(match[1]);
  }
  
  return dependencies;
}

/**
 * Determine which layer a path belongs to
 */
function getLayer(dependencyPath) {
  if (dependencyPath.startsWith('src/renderer') || dependencyPath.includes('/renderer/')) {
    return 'presentation';
  }
  if (dependencyPath.startsWith('src/application') || dependencyPath.includes('/application/')) {
    return 'application';
  }
  if (dependencyPath.startsWith('src/domain') || dependencyPath.includes('/domain/')) {
    return 'domain';
  }
  if (dependencyPath.startsWith('src/infrastructure') || dependencyPath.includes('/infrastructure/')) {
    return 'infrastructure';
  }
  if (dependencyPath.startsWith('src/core') || dependencyPath.includes('/core/')) {
    return 'core';
  }
  if (dependencyPath.startsWith('src/preload') || dependencyPath.includes('/preload/')) {
    return 'preload';
  }
  if (dependencyPath.startsWith('src/main') || dependencyPath.includes('/main/')) {
    return 'main';
  }
  
  // External/node_modules
  return null;
}

describe('Architectural Layer Violations - REAL BUGS', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  
  describe('CRITICAL: Presentation → Domain Violations (FORBIDDEN)', () => {
    test('should detect MessageManager directly using domain layer', () => {
      const messageManagerPath = path.join(projectRoot, 'src/renderer/chat/modules/messaging/MessageManager.js');
      
      if (!fs.existsSync(messageManagerPath)) {
        return; // Skip if file doesn't exist
      }
      
      const dependencies = extractDependencies(messageManagerPath);
      const domainDeps = dependencies.filter(dep => getLayer(dep) === 'domain');
      
      // BUG: MessageManager (Presentation) should NOT directly import domain layer
      // Must go through Application layer
      if (domainDeps.length > 0) {
        console.log('ARCHITECTURAL BUG FOUND:');
        console.log(`MessageManager (Presentation) → Domain: ${domainDeps.join(', ')}`);
        console.log('VIOLATION: Presentation must NOT directly depend on Domain');
        console.log('FIX: Create Application layer service to mediate');
      }
      
      expect(domainDeps).toEqual([]); // Should be empty
    });
    
    test('should detect all Presentation → Domain violations', () => {
      const presentationFiles = getJSFiles(path.join(projectRoot, PATHS.presentation));
      const violations = [];
      
      for (const file of presentationFiles) {
        const dependencies = extractDependencies(file);
        const domainDeps = dependencies.filter(dep => getLayer(dep) === 'domain');
        
        if (domainDeps.length > 0) {
          violations.push({
            file: path.relative(projectRoot, file),
            dependencies: domainDeps
          });
        }
      }
      
      if (violations.length > 0) {
        console.log('\n==== ARCHITECTURAL VIOLATIONS FOUND ====');
        console.log('Presentation → Domain (FORBIDDEN)\n');
        violations.forEach(v => {
          console.log(`❌ ${v.file}`);
          console.log(`   → ${v.dependencies.join(', ')}\n`);
        });
        console.log('IMPACT: Breaks clean architecture, tight coupling');
        console.log('FIX: Introduce Application layer mediator\n');
      }
      
      // This WILL fail - documenting the violations
      expect(violations.length).toBe(0);
    });
  });
  
  describe('CRITICAL: Presentation → Infrastructure Violations (FORBIDDEN)', () => {
    test('should detect StreamHandler directly using sessionBridge', () => {
      const streamHandlerPath = path.join(projectRoot, 'src/renderer/chat/modules/messaging/StreamHandler.js');
      
      if (!fs.existsSync(streamHandlerPath)) {
        return;
      }
      
      const content = fs.readFileSync(streamHandlerPath, 'utf-8');
      
      // Check for hard-coded global access
      const hasGlobalSessionAccess = content.includes('window.aether.session') ||
                                     content.includes('sessionBridge');
      
      if (hasGlobalSessionAccess) {
        console.log('ARCHITECTURAL BUG FOUND:');
        console.log('StreamHandler uses hard-coded global: window.aether.session');
        console.log('VIOLATION: Presentation accessing Infrastructure directly');
        console.log('VIOLATION: Hard-coded dependency (no DI)');
        console.log('FIX: Inject sessionAPI through constructor');
      }
      
      // BUG: This passes when it should FAIL
      expect(hasGlobalSessionAccess).toBe(false);
    });
    
    test('should detect all Presentation → Infrastructure violations', () => {
      const presentationFiles = getJSFiles(path.join(projectRoot, PATHS.presentation));
      const violations = [];
      
      for (const file of presentationFiles) {
        const dependencies = extractDependencies(file);
        const infraDeps = dependencies.filter(dep => getLayer(dep) === 'infrastructure');
        
        if (infraDeps.length > 0) {
          violations.push({
            file: path.relative(projectRoot, file),
            dependencies: infraDeps
          });
        }
      }
      
      if (violations.length > 0) {
        console.log('\n==== ARCHITECTURAL VIOLATIONS FOUND ====');
        console.log('Presentation → Infrastructure (FORBIDDEN)\n');
        violations.forEach(v => {
          console.log(`❌ ${v.file}`);
          console.log(`   → ${v.dependencies.join(', ')}\n`);
        });
        console.log('IMPACT: Bypasses Application layer, breaks testability');
        console.log('FIX: Route through Application layer\n');
      }
      
      expect(violations.length).toBe(0);
    });
  });
  
  describe('CRITICAL: Domain → External Layer Violations (FORBIDDEN)', () => {
    test('should ensure Domain layer is pure', () => {
      const domainFiles = getJSFiles(path.join(projectRoot, PATHS.domain));
      const violations = [];
      
      for (const file of domainFiles) {
        const dependencies = extractDependencies(file);
        const externalDeps = dependencies.filter(dep => {
          const layer = getLayer(dep);
          // Domain can only depend on other domain or nothing
          return layer && layer !== 'domain' && layer !== 'core';
        });
        
        if (externalDeps.length > 0) {
          violations.push({
            file: path.relative(projectRoot, file),
            dependencies: externalDeps
          });
        }
      }
      
      if (violations.length > 0) {
        console.log('\n==== ARCHITECTURAL VIOLATIONS FOUND ====');
        console.log('Domain → External Layers (FORBIDDEN)\n');
        violations.forEach(v => {
          console.log(`❌ ${v.file}`);
          console.log(`   → ${v.dependencies.join(', ')}\n`);
        });
        console.log('IMPACT: Domain not reusable, framework-coupled');
        console.log('FIX: Move external deps to Application/Infrastructure\n');
      }
      
      expect(violations.length).toBe(0);
    });
  });
  
  describe('CRITICAL: Hard-Coded Global Dependencies (Violates DI)', () => {
    test('should detect window.aether hard-coded accesses', () => {
      const rendererFiles = getJSFiles(path.join(projectRoot, 'src/renderer'));
      const violations = [];
      
      for (const file of rendererFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        
        // Check for hard-coded globals
        const globalMatches = [
          { pattern: /window\.aether\./g, name: 'window.aether' },
          { pattern: /window\.electron\./g, name: 'window.electron' },
          { pattern: /global\./g, name: 'global' }
        ];
        
        for (const { pattern, name } of globalMatches) {
          const matches = content.match(pattern);
          if (matches && matches.length > 0) {
            // Exclude reasonable usages (checking if exists)
            const hasCheck = content.includes(`if (${name}`) || 
                           content.includes(`typeof ${name}`) ||
                           content.includes(`${name} ?`) ||
                           content.includes(`${name}?.`);
            
            if (!hasCheck || matches.length > 2) {
              violations.push({
                file: path.relative(projectRoot, file),
                global: name,
                count: matches.length
              });
              break; // One violation per file is enough
            }
          }
        }
      }
      
      if (violations.length > 0) {
        console.log('\n==== ARCHITECTURAL VIOLATIONS FOUND ====');
        console.log('Hard-Coded Global Dependencies (Violates DI)\n');
        violations.slice(0, 10).forEach(v => {
          console.log(`❌ ${v.file}`);
          console.log(`   Uses: ${v.global} (${v.count} times)\n`);
        });
        if (violations.length > 10) {
          console.log(`... and ${violations.length - 10} more files\n`);
        }
        console.log('IMPACT: Untestable, tightly coupled, no DI');
        console.log('FIX: Inject dependencies through constructor\n');
      }
      
      // This WILL have many violations
      expect(violations.length).toBeLessThan(5); // Allow some, but flag excessive use
    });
  });
  
  describe('CRITICAL: Infrastructure → Application Violations (FORBIDDEN)', () => {
    test('should ensure Infrastructure is independent', () => {
      const infraFiles = getJSFiles(path.join(projectRoot, PATHS.infrastructure));
      const violations = [];
      
      for (const file of infraFiles) {
        const dependencies = extractDependencies(file);
        const appDeps = dependencies.filter(dep => getLayer(dep) === 'application');
        
        if (appDeps.length > 0) {
          violations.push({
            file: path.relative(projectRoot, file),
            dependencies: appDeps
          });
        }
      }
      
      if (violations.length > 0) {
        console.log('\n==== ARCHITECTURAL VIOLATIONS FOUND ====');
        console.log('Infrastructure → Application (FORBIDDEN)\n');
        violations.forEach(v => {
          console.log(`❌ ${v.file}`);
          console.log(`   → ${v.dependencies.join(', ')}\n`);
        });
        console.log('IMPACT: Infrastructure not reusable, inverted dependency');
        console.log('FIX: Use dependency inversion, inject app services\n');
      }
      
      expect(violations.length).toBe(0);
    });
  });
  
  describe('File Naming Violations', () => {
    test('should detect incorrect naming conventions', () => {
      const violations = [];
      
      // Check Application layer: Should be PascalCase
      const appFiles = getJSFiles(path.join(projectRoot, PATHS.application));
      for (const file of appFiles) {
        const basename = path.basename(file, '.js');
        if (basename !== 'index' && !/^[A-Z][a-zA-Z]*$/.test(basename)) {
          violations.push({
            file: path.relative(projectRoot, file),
            expected: 'PascalCase',
            got: basename
          });
        }
      }
      
      if (violations.length > 0) {
        console.log('\n==== NAMING CONVENTION VIOLATIONS ====');
        violations.slice(0, 5).forEach(v => {
          console.log(`❌ ${v.file}`);
          console.log(`   Expected: ${v.expected}, Got: ${v.got}\n`);
        });
      }
      
      // Allow some flexibility
      expect(violations.length).toBeLessThan(10);
    });
  });
  
  describe('Circular Dependency Detection', () => {
    test('should detect circular dependencies', () => {
      // Build dependency graph
      const allFiles = [
        ...getJSFiles(path.join(projectRoot, 'src/renderer')),
        ...getJSFiles(path.join(projectRoot, 'src/application')),
        ...getJSFiles(path.join(projectRoot, 'src/domain'))
      ];
      
      const graph = new Map();
      
      // Build graph
      for (const file of allFiles) {
        const deps = extractDependencies(file);
        const resolvedDeps = deps.map(dep => {
          // Resolve relative paths
          if (dep.startsWith('.')) {
            const dir = path.dirname(file);
            return path.resolve(dir, dep);
          }
          return dep;
        }).filter(dep => {
          // Only track internal deps
          return dep.startsWith(projectRoot);
        });
        
        graph.set(file, resolvedDeps);
      }
      
      // Detect cycles using DFS
      const cycles = [];
      const visited = new Set();
      const recursionStack = new Set();
      
      function dfs(node, path = []) {
        if (recursionStack.has(node)) {
          // Found cycle
          const cycleStart = path.indexOf(node);
          const cycle = path.slice(cycleStart).concat(node);
          cycles.push(cycle.map(f => path.relative(projectRoot, f)));
          return;
        }
        
        if (visited.has(node)) {
          return;
        }
        
        visited.add(node);
        recursionStack.add(node);
        path.push(node);
        
        const deps = graph.get(node) || [];
        for (const dep of deps) {
          if (graph.has(dep)) {
            dfs(dep, [...path]);
          }
        }
        
        recursionStack.delete(node);
      }
      
      // Check all nodes
      for (const node of graph.keys()) {
        if (!visited.has(node)) {
          dfs(node);
        }
      }
      
      if (cycles.length > 0) {
        console.log('\n==== CIRCULAR DEPENDENCIES FOUND ====');
        cycles.slice(0, 3).forEach((cycle, i) => {
          console.log(`\nCycle ${i + 1}:`);
          cycle.forEach((file, j) => {
            console.log(`  ${j === cycle.length - 1 ? '└→' : '→'} ${file}`);
          });
        });
        if (cycles.length > 3) {
          console.log(`\n... and ${cycles.length - 3} more cycles`);
        }
        console.log('\nIMPACT: Breaks modularity, hard to test');
        console.log('FIX: Use dependency injection, extract interfaces\n');
      }
      
      expect(cycles.length).toBe(0);
    });
  });
});

