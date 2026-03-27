#!/usr/bin/env node
'use strict';

/**
 * @.architecture
 * 
 * Incoming: Frontend .js/.jsx/.ts/.tsx files with @.architecture --- {JavaScript source files, regex patterns}
 * Processing: extractUsedJobs(), validateTokenFormat(), (optional) validateRegistryMembership() --- {4 jobs: JOB_PARSE_JSON, JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA, JOB_EMIT_EVENT}
 * Outgoing: stdout (validation report), exit code (0=valid, 1=invalid) --- {string console output, number exit code}
 * 
 * Job Type Validator
 * ==================================================
 * Validates that @.architecture documentation uses valid JOB_* tokens.
 * Optional: enforce registry membership via --strict-registry.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function stripArchitectureHeader(raw) {
  if (typeof raw !== 'string') {
    return raw;
  }
  const headerPattern = /^Incoming:[^\n]*\nProcessing:[^\n]*\nOutgoing:[^\n]*\n*/;
  return raw.replace(headerPattern, '');
}

// ============================================================================
// Load Registry (Optional)
// ============================================================================

function loadJobRegistry(registryPath) {
  const content = fs.readFileSync(registryPath, 'utf8');
  const registry = yaml.load(stripArchitectureHeader(content));

  const jobTypes = new Set();

  const catalog = registry && typeof registry === 'object' ? registry.catalog : undefined;
  if (catalog && typeof catalog === 'object') {
    for (const categoryValue of Object.values(catalog)) {
      if (!categoryValue || typeof categoryValue !== 'object') {
        continue;
      }

      const entries = Array.isArray(categoryValue.entries) ? categoryValue.entries : [];
      for (const entry of entries) {
        const id = entry && typeof entry === 'object' ? entry.id : undefined;
        if (typeof id === 'string' && id.trim().length > 0) {
          jobTypes.add(id.trim());
        }
      }
    }
  }

  const categories = registry && typeof registry === 'object' ? registry.categories : undefined;
  if (categories && typeof categories === 'object') {
    for (const categoryValue of Object.values(categories)) {
      if (!categoryValue || typeof categoryValue !== 'object') {
        continue;
      }

      const jobs = Array.isArray(categoryValue.jobs) ? categoryValue.jobs : [];
      for (const job of jobs) {
        if (typeof job === 'string' && job.trim().length > 0) {
          jobTypes.add(job.trim());
        }
      }
    }
  }

  return jobTypes;
}

// ============================================================================
// Extract Jobs from Files
// ============================================================================

function normalizeJobToken(token) {
  if (typeof token !== 'string') return null;
  const t = token.trim();
  if (!t) return null;
  return t;
}

function isValidJobToken(job) {
  return /^JOB_[A-Z0-9_]{2,}$/.test(job);
}

function extractJobsFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Find Processing line in @.architecture
    // Format: Processing: ... --- {N jobs: JOB_X, JOB_Y, ...}
    const archRegex = /@\.architecture.*?Processing:.*?---\s*\{[^}]*jobs?:\s*([^}]+)\}/s;
    const match = content.match(archRegex);
    
    if (!match) {
      return { jobs: [], invalid: [] };
    }
    
    const jobsStr = match[1];
    
    // Split by comma and clean
    const jobs = jobsStr
      .split(',')
      .map(normalizeJobToken)
      .filter(Boolean);

    const invalid = jobs.filter(job => job !== 'none' && !isValidJobToken(job));
    return { jobs, invalid };
    
  } catch (err) {
    console.error(`⚠️  Error reading ${filePath}: ${err.message}`);
    return { jobs: [], invalid: ['__read_error__'] };
  }
}

// ============================================================================
// Find Files
// ============================================================================

async function findJavaScriptFiles(rootDir, excludeDirs) {
  const files = [];
  
  async function walk(currentPath) {
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      
      if (entry.isDirectory()) {
        if (!excludeDirs.includes(entry.name) && !entry.name.startsWith('.')) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }
  
  await walk(rootDir);
  return files;
}

// ============================================================================
// Validate
// ============================================================================

async function validateJobTypes(frontendRoot) {
  const strictRegistry = process.argv.includes('--strict-registry');

  // Load registry (optional)
  const registryPath = path.join(frontendRoot, '..', 'Architecture', 'frontend_job_registry.yaml');
  const hasRegistry = fs.existsSync(registryPath);
  if (strictRegistry && !hasRegistry) {
    console.error(`Registry not found (strict): ${registryPath}`);
    return { valid: false, violations: { __registry_missing__: [registryPath] } };
  }

  const registeredJobs = hasRegistry ? loadJobRegistry(registryPath) : null;
  if (registeredJobs) {
    console.log(`Loaded ${registeredJobs.size} registered job types from registry`);
  } else {
    console.log('Registry: not configured (skipping membership enforcement). Use --strict-registry to require it.');
  }
  
  // Find all JS/TS files
  const excludeDirs = ['node_modules', '.next', 'dist', 'build', 'coverage', 'test-results'];
  const jsFiles = await findJavaScriptFiles(frontendRoot, excludeDirs);
  console.log(`Scanning ${jsFiles.length} JavaScript/TypeScript files...\n`);
  
  // Track violations
  const violations = {};
  const invalidJobTokens = {};
  let filesWithArch = 0;
  const unregisteredJobs = new Set();
  
  for (const jsFile of jsFiles) {
    const { jobs, invalid } = extractJobsFromFile(jsFile);
    if (jobs.length === 0 && invalid.length === 0) {
      continue;
    }
    
    filesWithArch++;
    const relPath = path.relative(frontendRoot, jsFile);

    if (invalid.length > 0) {
      invalidJobTokens[relPath] = invalid;
    }
    
    for (const job of jobs) {
      if (job === 'none') {
        continue;
      }
      if (registeredJobs && !registeredJobs.has(job)) {
        if (!violations[job]) {
          violations[job] = [];
        }
        violations[job].push(relPath);
        unregisteredJobs.add(job);
      }
    }
  }
  
  // Report results
  console.log('='.repeat(80));
  console.log('📊 VALIDATION RESULTS');
  console.log('='.repeat(80));
  console.log(`\n✅ Files scanned: ${jsFiles.length}`);
  console.log(`✅ Files with @.architecture: ${filesWithArch}`);
  if (registeredJobs) {
    console.log(`✅ Registered job types: ${registeredJobs.size}`);
  }

  const invalidFiles = Object.keys(invalidJobTokens).length;
  if (invalidFiles > 0) {
    console.log(`\n❌ Invalid job tokens found in ${invalidFiles} file(s)\n`);
    Object.entries(invalidJobTokens)
      .slice(0, 10)
      .forEach(([file, toks]) => {
        console.log(`⚠️  ${file}`);
        console.log(`   Invalid: ${toks.join(', ')}`);
      });
    if (invalidFiles > 10) {
      console.log(`... and ${invalidFiles - 10} more`);
    }
  }

  if (registeredJobs && Object.keys(violations).length > 0) {
    console.log(`\n❌ Unregistered job types found: ${unregisteredJobs.size}\n`);
    
    const sortedJobs = Array.from(unregisteredJobs).sort();
    for (const job of sortedJobs) {
      console.log(`\n⚠️  Unregistered job type: '${job}'`);
      console.log(`   Used in ${violations[job].length} file(s):`);
      const filesToShow = violations[job].slice(0, 5);
      for (const filePath of filesToShow) {
        console.log(`   - ${filePath}`);
      }
      if (violations[job].length > 5) {
        console.log(`   ... and ${violations[job].length - 5} more`);
      }
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('❌ VALIDATION FAILED');
    console.log('='.repeat(80));
    
    return { valid: false, violations };
  }

  if (invalidFiles > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('❌ VALIDATION FAILED');
    console.log('='.repeat(80));
    return { valid: false, violations: { __invalid_job_tokens__: invalidJobTokens } };
  }

  {
    console.log(`\n✅ All job types are registered!\n`);
    console.log('='.repeat(80));
    console.log('✅ VALIDATION PASSED');
    console.log('='.repeat(80));
    return { valid: true, violations: {} };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\nFrontend Job Type Validator\n');
  
  // Find frontend root
  const scriptDir = __dirname;
  const frontendRoot = path.dirname(scriptDir);
  
  // Validate
  const result = await validateJobTypes(frontendRoot);
  
  // Exit with appropriate code
  process.exit(result.valid ? 0 : 1);
}

// Run
main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});

