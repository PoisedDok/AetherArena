#!/usr/bin/env node
'use strict';

/**
 * @.architecture
 * 
 * Incoming: .architecture/job_types.yaml, Frontend .js/.jsx/.ts/.tsx files with @.architecture --- {YAML config, JavaScript source files, regex patterns}
 * Processing: parseRegistry(), extractUsedJobs(), validateCompliance(), reportViolations() --- {4 jobs: JOB_PARSE_JSON, JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA, JOB_EMIT_EVENT}
 * Outgoing: stdout (validation report), exit code (0=valid, 1=invalid) --- {string console output, number exit code}
 * 
 * Job Type Registry Validator
 * ==================================================
 * Validates that all @.architecture documentation uses only registered JOB_* types.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ============================================================================
// Load Registry
// ============================================================================

function loadJobRegistry(registryPath) {
  const content = fs.readFileSync(registryPath, 'utf8');
  const registry = yaml.load(content);
  
  const jobTypes = new Set();
  
  // Extract job types from all categories
  for (const [categoryKey, categoryData] of Object.entries(registry)) {
    if (typeof categoryData === 'object' && 
        !['version', 'domain', 'execution_rules'].includes(categoryKey)) {
      for (const [jobName, jobInfo] of Object.entries(categoryData)) {
        if (typeof jobInfo === 'object') {
          jobTypes.add(jobName);
        }
      }
    }
  }
  
  return jobTypes;
}

// ============================================================================
// Extract Jobs from Files
// ============================================================================

function extractJobsFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Find Processing line in @.architecture
    // Format: Processing: ... --- {N jobs: JOB_X, JOB_Y, ...}
    const archRegex = /@\.architecture.*?Processing:.*?---\s*\{[^}]*jobs?:\s*([^}]+)\}/s;
    const match = content.match(archRegex);
    
    if (!match) {
      return [];
    }
    
    const jobsStr = match[1];
    
    // Split by comma and clean
    const jobs = jobsStr.split(',').map(j => j.trim());
    
    return jobs;
    
  } catch (err) {
    console.error(`⚠️  Error reading ${filePath}: ${err.message}`);
    return [];
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
  // Load registry
  const registryPath = path.join(frontendRoot, '.architecture', 'job_types.yaml');
  if (!fs.existsSync(registryPath)) {
    console.error(`❌ Registry not found: ${registryPath}`);
    return { valid: false, violations: {} };
  }
  
  const registeredJobs = loadJobRegistry(registryPath);
  console.log(`📋 Loaded ${registeredJobs.size} registered job types from registry`);
  
  // Find all JS/TS files
  const excludeDirs = ['node_modules', '.next', 'dist', 'build', 'coverage', 'test-results'];
  const jsFiles = await findJavaScriptFiles(frontendRoot, excludeDirs);
  console.log(`🔍 Scanning ${jsFiles.length} JavaScript/TypeScript files...\n`);
  
  // Track violations
  const violations = {};
  let filesWithArch = 0;
  const unregisteredJobs = new Set();
  
  for (const jsFile of jsFiles) {
    const jobs = extractJobsFromFile(jsFile);
    if (jobs.length === 0) {
      continue;
    }
    
    filesWithArch++;
    const relPath = path.relative(frontendRoot, jsFile);
    
    for (const job of jobs) {
      if (!registeredJobs.has(job)) {
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
  console.log(`✅ Registered job types: ${registeredJobs.size}`);
  
  if (Object.keys(violations).length > 0) {
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
    console.log('\nTo fix:');
    console.log('1. Add missing job types to .architecture/job_types.yaml');
    console.log('2. Or update files to use registered job types');
    console.log('3. Run this script again to verify');
    
    return { valid: false, violations };
  } else {
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
  console.log('\n🔍 Frontend Job Type Registry Validator\n');
  
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

