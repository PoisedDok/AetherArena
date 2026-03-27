#!/usr/bin/env node
'use strict';
// Incoming: aether-frontend/src/** --- {filesystem}
// Processing: Scan @.architecture docs, index jobs, audit budgets --- {2 jobs: JOB_PARSE_JSON, JOB_VALIDATE_SCHEMA}
// Outgoing: stdout, aether-frontend/architecture_index.json --- {Dict[str, Any], json}

/**
 * @.architecture
 * 
 * Incoming: Command line args, Frontend .js/.jsx/.ts/.tsx files with @.architecture --- {argv array, string file contents, regex patterns}
 * Processing: Parse @.architecture blocks, extract JOB_* codes, index by job type, search/trace/export --- {4 jobs: JOB_PARSE_JSON, JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA, JOB_EMIT_EVENT}
 * Outgoing: stdout formatted output, JSON export files --- {string console output, json architecture index}
 * 
 * Job Type Tracer - Frontend Pipeline Analysis Tool
 * ============================================================================
 * Searches and traces JOB_* types across the entire frontend architecture.
 * Uses @.architecture documentation to map complete data flow pipelines.
 * 
 * Features:
 * - Parse @.architecture documentation from all JS/JSX/TS/TSX files
 * - Index files by JOB_* type
 * - Search for single or multiple job types
 * - Trace complete data flow pipelines
 * - Export results as JSON
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { promisify } = require('util');
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

const TARGETS_FILENAME = 'job_type_targets.yaml';
const JOB_LAYER_MAP = {
  renderer: 'renderer_surface',
  application: 'application_brain',
  main: 'main_process',
  domain: 'domain_rules',
  infrastructure: 'infrastructure_bridges',
  core: 'core_foundation',
  preload: 'preload_boundary',
  scripts: 'shared_assets',
  tests: 'shared_assets',
  assets: 'shared_assets',
  resources: 'shared_assets',
  build: 'shared_assets',
  dist: 'shared_assets',
  data: 'shared_assets',
  logs: 'shared_assets'
};

function stripArchitectureHeader(raw) {
  if (typeof raw !== 'string') {
    return raw;
  }

  const headerPattern = /^Incoming:[^\n]*\nProcessing:[^\n]*\nOutgoing:[^\n]*\n*/;
  return raw.replace(headerPattern, '');
}

function loadJobTargetsFile(frontendRoot) {
  const targetsPath = path.join(frontendRoot, '.architecture', TARGETS_FILENAME);
  if (!fs.existsSync(targetsPath)) {
    return {};
  }

  const raw = fs.readFileSync(targetsPath, 'utf-8');
  let parsed;
  try {
    parsed = YAML.parse(stripArchitectureHeader(raw)) || {};
  } catch (err) {
    throw new Error(`Unable to parse ${targetsPath}: ${err.message}`);
  }

  const specTargets = parsed.targets || {};
  const normalized = {};
  for (const [job, spec] of Object.entries(specTargets)) {
    if (!spec || typeof spec !== 'object') {
      continue;
    }
    const layerCaps = {};
    for (const [layer, cap] of Object.entries(spec.layer_caps || {})) {
      layerCaps[layer] = Number(cap);
    }
    normalized[job] = {
      description: spec.description || '',
      target_total: Number(spec.target_total || 0),
      layer_caps: layerCaps
    };
  }

  return normalized;
}

/**
 * Load allowed job types from frontend job registry (optional).
 *
 * NOTE:
 * - Historically this repo referenced `../Architecture/frontend_job_registry.yaml` as a canonical registry.
 * - That registry is not required for the tracer to function.
 * - If the registry is missing, the tracer still works and will not fail on "unknown job types".
 * - Use `--strict-registry` to require the registry and enforce membership.
 */
function loadAllowedJobTypes(frontendRoot) {
  const registryPath = path.join(frontendRoot, '..', 'Architecture', 'frontend_job_registry.yaml');
  if (!fs.existsSync(registryPath)) {
    return null;
  }
  const raw = fs.readFileSync(registryPath, 'utf-8');
  const parsed = YAML.parse(stripArchitectureHeader(raw));

  const allowed = new Set();

  const catalog = parsed && typeof parsed === 'object' ? parsed.catalog : undefined;
  if (catalog && typeof catalog === 'object') {
    for (const categoryValue of Object.values(catalog)) {
      if (!categoryValue || typeof categoryValue !== 'object') {
        continue;
      }

      const entries = Array.isArray(categoryValue.entries) ? categoryValue.entries : [];
      for (const entry of entries) {
        const id = entry && typeof entry === 'object' ? entry.id : undefined;
        if (typeof id === 'string' && id.trim().length > 0) {
          allowed.add(id.trim());
        }
      }
    }
  }

  const categories = parsed && typeof parsed === 'object' ? parsed.categories : undefined;
  if (categories && typeof categories === 'object') {
    for (const categoryValue of Object.values(categories)) {
      if (!categoryValue || typeof categoryValue !== 'object') {
        continue;
      }

      const jobs = Array.isArray(categoryValue.jobs) ? categoryValue.jobs : [];
      for (const job of jobs) {
        if (typeof job === 'string' && job.trim().length > 0) {
          allowed.add(job.trim());
        }
      }
    }
  }

  if (allowed.size === 0) {
    throw new Error(`Job registry at ${registryPath} did not yield any job definitions.`);
  }

  return allowed;
}

// ============================================================================
// Architecture Info Class
// ============================================================================

class ArchitectureInfo {
  constructor(filePath, incoming, processing, outgoing, jobTypes = [], jobCount = 0) {
    this.filePath = filePath;
    this.incoming = incoming;
    this.processing = processing;
    this.outgoing = outgoing;
    this.jobTypes = jobTypes;
    this.jobCount = jobCount;
  }

  toString() {
    return `<ArchitectureInfo: ${path.basename(this.filePath)} - ${this.jobTypes.length} jobs>`;
  }
}

// ============================================================================
// Job Tracer Class
// ============================================================================

class JobTracer {
  constructor(frontendRoot, allowedJobTypes) {
    this.frontendRoot = frontendRoot;
    this.allowedJobTypes = allowedJobTypes;
    this.architectures = [];
    this.jobIndex = new Map();
    this.allJobTypes = new Set();
    this.unknownJobTypes = new Set();
    this.jobTargets = {};
  }

  /**
   * Scan repository for @.architecture documentation
   */
  async scanRepository(excludeDirs = ['node_modules', '.next', 'dist', 'build', 'coverage', 'test-results']) {
    console.log(`Scanning ${this.frontendRoot} for @.architecture documentation...`);
    
    const files = await this._findFiles(this.frontendRoot, excludeDirs);
    let filesScanned = 0;

    for (const file of files) {
      try {
        const archInfo = await this._parseArchitectureFile(file);
        if (archInfo) {
          this.architectures.push(archInfo);
          
          // Index by job types
          for (const jobType of archInfo.jobTypes) {
            if (!this.jobIndex.has(jobType)) {
              this.jobIndex.set(jobType, []);
            }
            this.jobIndex.get(jobType).push(archInfo);
            this.allJobTypes.add(jobType);

            if (this.allowedJobTypes && !this.allowedJobTypes.has(jobType)) {
              this.unknownJobTypes.add(jobType);
            }
          }
          
          filesScanned++;
        }
      } catch (err) {
        console.error(`⚠️  Error parsing ${file}: ${err.message}`);
      }
    }

    console.log(`Scanned ${filesScanned} files`);
    console.log(`Found ${this.allJobTypes.size} unique job types`);
    if (this.allowedJobTypes) {
      const registeredObserved = this.allJobTypes.size - this.unknownJobTypes.size;
      console.log(`Registry coverage: ${registeredObserved}/${this.allJobTypes.size} observed types registered`);
    } else {
      console.log('Registry: not configured (skipping membership enforcement). Use --strict-registry to require it.');
    }
    
    return filesScanned;
  }

  /**
   * Find all JS/JSX/TS/TSX files recursively
   */
  async _findFiles(dir, excludeDirs) {
    const files = [];
    
    async function walk(currentPath) {
      const entries = await readdir(currentPath, { withFileTypes: true });
      
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
    
    await walk(dir);
    return files;
  }

  /**
   * Parse @.architecture documentation from a file
   */
  async _parseArchitectureFile(filePath) {
    try {
      const content = await readFile(filePath, 'utf-8');
      
      // Find @.architecture section
      // Format:
      // Incoming: ... --- {...}
      // Processing: ... --- {N jobs: JOB_X, JOB_Y, ...}
      // Outgoing: ... --- {...}
      const archRegex = /@\.architecture\s*\n\s*\*?\s*\n?\s*\*?\s*Incoming:\s*([^\n]+?)\s*---\s*\{([^\}]+)\}\s*\n\s*\*?\s*Processing:\s*([^\n]+?)\s*---\s*\{([^\}]+)\}\s*\n\s*\*?\s*Outgoing:\s*([^\n]+?)\s*---\s*\{([^\}]+)\}/m;
      
      const match = content.match(archRegex);
      
      if (!match) {
        return null;
      }
      
      const incomingSources = match[1].trim();
      const incomingTypes = match[2].trim();
      const processingFuncs = match[3].trim();
      const processingJobs = match[4].trim();
      const outgoingDests = match[5].trim();
      const outgoingTypes = match[6].trim();
      
      // Parse job types and count
      // Format: "N jobs: JOB_TYPE1, JOB_TYPE2, ..."
      const jobMatch = processingJobs.match(/(\d+)\s+jobs?:\s*(.+)/);
      let jobCount = 0;
      let jobTypes = [];
      
      if (jobMatch) {
        jobCount = parseInt(jobMatch[1]);
        const jobTypesStr = jobMatch[2];
        jobTypes = jobTypesStr.split(',').map(jt => jt.trim());
      }
      
      return new ArchitectureInfo(
        filePath,
        `${incomingSources} --- {${incomingTypes}}`,
        `${processingFuncs} --- {${processingJobs}}`,
        `${outgoingDests} --- {${outgoingTypes}}`,
        jobTypes,
        jobCount
      );
      
    } catch (err) {
      console.error(`Error reading ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Search for files by job type(s)
   */
  searchJobTypes(jobTypes, matchMode = 'any') {
    const results = [];
    
    for (const arch of this.architectures) {
      const archJobsLower = arch.jobTypes.map(j => j.toLowerCase());
      const searchJobsLower = jobTypes.map(j => j.toLowerCase());
      
      if (matchMode === 'any') {
        // Match if any job type matches
        if (searchJobsLower.some(searchJob => archJobsLower.includes(searchJob))) {
          results.push(arch);
        }
      } else if (matchMode === 'all') {
        // Match if all job types present
        if (searchJobsLower.every(searchJob => archJobsLower.includes(searchJob))) {
          results.push(arch);
        }
      }
    }
    
    return results;
  }

  /**
   * Fuzzy search for job types matching query
   */
  fuzzySearchJobs(query) {
    const queryLower = query.toLowerCase();
    return Array.from(this.allJobTypes)
      .filter(job => job.toLowerCase().includes(queryLower))
      .sort();
  }

  /**
   * Trace complete pipeline for a job type
   */
  tracePipeline(jobType) {
    const matchingFiles = this.jobIndex.get(jobType) || [];
    
    if (matchingFiles.length === 0) {
      return {
        jobType,
        found: false,
        files: []
      };
    }
    
    // Organize by layer
    const layers = new Map();
    
    for (const arch of matchingFiles) {
      const relativePath = path.relative(this.frontendRoot, arch.filePath);
      const layer = this._determineLayer(relativePath);
      
      if (!layers.has(layer)) {
        layers.set(layer, []);
      }
      layers.get(layer).push(arch);
    }
    
    return {
      jobType,
      found: true,
      totalFiles: matchingFiles.length,
      layers: Object.fromEntries(
        Array.from(layers.entries()).map(([layer, files]) => [layer, files.length])
      ),
      files: matchingFiles
    };
  }

  /**
   * Determine layer from file path
   */
  _determineLayer(relativePath) {
    if (relativePath.includes('renderer/artifacts')) return 'Artifacts';
    if (relativePath.includes('renderer/chat')) return 'Chat';
    if (relativePath.includes('renderer/settings')) return 'Settings';
    if (relativePath.includes('renderer/models')) return 'Models';
    if (relativePath.includes('renderer/shared')) return 'Shared UI';
    if (relativePath.includes('domain/chat')) return 'Chat Domain';
    if (relativePath.includes('domain/settings')) return 'Settings Domain';
    if (relativePath.includes('domain/')) return 'Domain Layer';
    if (relativePath.includes('infrastructure/api')) return 'API Client';
    if (relativePath.includes('infrastructure/websocket')) return 'WebSocket';
    if (relativePath.includes('infrastructure/ipc')) return 'IPC';
    if (relativePath.includes('infrastructure/persistence')) return 'Persistence';
    if (relativePath.includes('infrastructure/')) return 'Infrastructure';
    if (relativePath.includes('main/')) return 'Main Process';
    if (relativePath.includes('preload/')) return 'Preload';
    if (relativePath.includes('scripts/')) return 'Scripts';
    return 'Other';
  }

  _resolveLayer(filePath) {
    const relativePath = path.relative(this.frontendRoot, filePath);
    const parts = relativePath.split(path.sep).filter(Boolean);
    if (parts.length === 0) {
      return 'shared_assets';
    }
    if (parts[0] === 'src' && parts.length > 1) {
      return JOB_LAYER_MAP[parts[1]] || 'shared_assets';
    }
    return JOB_LAYER_MAP[parts[0]] || 'shared_assets';
  }

  /**
   * Display search results
   */
  displaySearchResults(results, jobTypes) {
    console.log('\n' + '='.repeat(80));
    console.log(`🔍 SEARCH RESULTS: ${jobTypes.join(', ')}`);
    console.log('='.repeat(80));
    console.log(`\n📊 Found ${results.length} file(s) matching job type(s): ${jobTypes.join(', ')}\n`);
    
    if (results.length === 0) {
      console.log('No files found.');
      return;
    }
    
    results.forEach((arch, i) => {
      const relPath = path.relative(this.frontendRoot, arch.filePath);
      
      console.log(`\n${i + 1}. 📄 ${relPath}`);
      console.log(`   ${'─'.repeat(70)}`);
      console.log(`   Jobs: ${arch.jobTypes.join(', ')} (${arch.jobCount} total)`);
      console.log(`   `);
      console.log(`   ⬇️  Incoming:  ${arch.incoming}`);
      console.log(`   ⚙️  Processing: ${arch.processing}`);
      console.log(`   ⬆️  Outgoing:   ${arch.outgoing}`);
    });
  }

  /**
   * Display pipeline trace
   */
  displayPipelineTrace(jobType) {
    const pipeline = this.tracePipeline(jobType);
    
    console.log('\n' + '='.repeat(80));
    console.log(`🔬 PIPELINE TRACE: ${jobType}`);
    console.log('='.repeat(80));
    
    if (!pipeline.found) {
      console.log(`\n❌ No files found for job type: ${jobType}`);
      return;
    }
    
    console.log(`\n📊 Found ${pipeline.totalFiles} file(s) implementing '${jobType}'\n`);
    
    // Display by layer
    console.log('📂 Distribution by Layer:');
    Object.entries(pipeline.layers)
      .sort((a, b) => b[1] - a[1])
      .forEach(([layer, count]) => {
        console.log(`   • ${layer}: ${count} file(s)`);
      });
    
    console.log('\n🗺️  Complete Pipeline:\n');
    
    // Group by layer
    const layerMap = new Map();
    for (const arch of pipeline.files) {
      const relPath = path.relative(this.frontendRoot, arch.filePath);
      const layer = this._determineLayer(relPath);
      
      if (!layerMap.has(layer)) {
        layerMap.set(layer, []);
      }
      layerMap.get(layer).push(arch);
    }
    
    // Sort layers
    const layerOrder = [
      'Main Process', 'Preload', 'Artifacts', 'Chat', 'Settings', 'Models',
      'Shared UI', 'Chat Domain', 'Settings Domain', 'Domain Layer',
      'API Client', 'WebSocket', 'IPC', 'Persistence', 'Infrastructure',
      'Scripts', 'Other'
    ];
    
    const sortedLayers = Array.from(layerMap.entries()).sort((a, b) => {
      const indexA = layerOrder.indexOf(a[0]);
      const indexB = layerOrder.indexOf(b[0]);
      return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
    });
    
    // Display in layer order
    sortedLayers.forEach(([layer, files]) => {
      console.log(`\n   ${layer}`);
      console.log(`   ${'─'.repeat(70)}`);
      
      files.forEach(arch => {
        const relPath = path.relative(this.frontendRoot, arch.filePath);
        console.log(`   └─ 📄 ${relPath}`);
        console.log(`      ⬇️  ${arch.incoming}`);
        console.log(`      ⚙️  ${arch.processing}`);
        console.log(`      ⬆️  ${arch.outgoing}`);
        console.log();
      });
    });
  }

  /**
   * List all job types
   */
  listAllJobTypes(sortBy = 'name') {
    console.log('\n' + '='.repeat(80));
    console.log('📋 ALL JOB TYPES');
    console.log('='.repeat(80));
    console.log(`\n📊 Total unique job types: ${this.allJobTypes.size}\n`);
    
    if (sortBy === 'frequency') {
      // Count occurrences
      const jobCounts = new Map();
      for (const arch of this.architectures) {
        for (const job of arch.jobTypes) {
          jobCounts.set(job, (jobCounts.get(job) || 0) + 1);
        }
      }
      
      // Sort by frequency
      const sorted = Array.from(jobCounts.entries())
        .sort((a, b) => b[1] - a[1]);
      
      sorted.forEach(([job, count]) => {
        console.log(`   • ${job.padEnd(50)} (${count} file(s))`);
      });
    } else {
      // Alphabetical
      const sorted = Array.from(this.allJobTypes).sort();
      sorted.forEach(job => {
        const count = this.jobIndex.get(job)?.length || 0;
        console.log(`   • ${job.padEnd(50)} (${count} file(s))`);
      });
    }
  }

  auditJobTargets(outputJson = false) {
    if (!this.jobTargets || Object.keys(this.jobTargets).length === 0) {
      console.warn('⚠️  No job_type_targets.yaml found; skipping audit.');
      return;
    }

    const jobCounts = new Map();
    for (const [job, files] of this.jobIndex.entries()) {
      jobCounts.set(job, files.length);
    }

    const report = [];
    const offenders = [];

    for (const [job, spec] of Object.entries(this.jobTargets)) {
      const actualTotal = jobCounts.get(job) || 0;
      const targetTotal = spec.target_total || 0;
      const layerCaps = spec.layer_caps || {};

      const layerCounts = {};
      const files = this.jobIndex.get(job) || [];
      for (const arch of files) {
        const layer = this._resolveLayer(arch.filePath);
        layerCounts[layer] = (layerCounts[layer] || 0) + 1;
      }

      const layerOverages = {};
      for (const [layer, cap] of Object.entries(layerCaps)) {
        const actual = layerCounts[layer] || 0;
        if (actual > cap) {
          layerOverages[layer] = actual - cap;
        }
      }

      const unmanagedLayers = {};
      for (const [layer, count] of Object.entries(layerCounts)) {
        if (layerCaps[layer] === undefined && count > 0) {
          unmanagedLayers[layer] = count;
        }
      }

      const deltaTotal = actualTotal - targetTotal;
      const entry = {
        job,
        description: spec.description || '',
        target_total: targetTotal,
        actual_total: actualTotal,
        delta_total: deltaTotal,
        layer_caps: layerCaps,
        layer_counts: layerCounts,
        layer_overages: layerOverages,
        unmanaged_layers: unmanagedLayers
      };

      report.push(entry);
      if (deltaTotal > 0 || Object.keys(layerOverages).length || Object.keys(unmanagedLayers).length) {
        offenders.push(entry);
      }
    }

    if (outputJson) {
      console.log(JSON.stringify({ report, offenders }, null, 2));
      return;
    }

    console.log('\n' + '='.repeat(80));
    console.log('🧮 JOB TARGET AUDIT');
    console.log('='.repeat(80));
    console.log(`\nTargets loaded: ${Object.keys(this.jobTargets).length} | Offenders: ${offenders.length}\n`);

    if (offenders.length === 0) {
      console.log('✅ All tracked job types are within target thresholds.\n');
      return;
    }

    offenders
      .sort((a, b) => b.delta_total - a.delta_total)
      .forEach(off => {
        console.log(`• ${off.job}: actual ${off.actual_total} / target ${off.target_total} (Δ ${off.delta_total})`);
        const overLayers = Object.entries(off.layer_overages);
        if (overLayers.length) {
          overLayers.forEach(([layer, extra]) => {
            const cap = off.layer_caps[layer];
            const actual = off.layer_counts[layer] || 0;
            console.log(`    - Layer ${layer}: ${actual} / cap ${cap} (over by ${extra})`);
          });
        }
        const unmanaged = Object.entries(off.unmanaged_layers);
        if (unmanaged.length) {
          unmanaged.forEach(([layer, count]) => {
            console.log(`    - Layer ${layer}: ${count} file(s) but no cap defined`);
          });
        }
        if (off.description) {
          console.log(`    · ${off.description}`);
        }
        console.log();
      });
  }

  /**
   * Export architecture index as JSON
   */
  async exportJson(outputFile) {
    const data = {
      totalFiles: this.architectures.length,
      totalJobTypes: this.allJobTypes.size,
      jobTypes: Array.from(this.allJobTypes).sort(),
      jobIndex: Object.fromEntries(
        Array.from(this.jobIndex.entries()).map(([job, files]) => [
          job,
          files.map(arch => ({
            file: path.relative(this.frontendRoot, arch.filePath),
            jobs: arch.jobTypes,
            jobCount: arch.jobCount,
            incoming: arch.incoming,
            processing: arch.processing,
            outgoing: arch.outgoing
          }))
        ])
      )
    };
    
    await fs.promises.writeFile(outputFile, JSON.stringify(data, null, 2));
    console.log(`\n✅ Exported architecture index to: ${outputFile}`);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  
  const command = args[0];
  const commandArgs = args.slice(1);
  const strictRegistry = commandArgs.includes('--strict-registry');
  
  // Find frontend root
  const scriptDir = __dirname;
  const frontendRoot = path.dirname(scriptDir);
  
  // Initialize tracer
  const allowedJobTypes = loadAllowedJobTypes(frontendRoot);
  if (strictRegistry && !allowedJobTypes) {
    console.error('Fatal: --strict-registry set but job registry not found at ../Architecture/frontend_job_registry.yaml');
    process.exit(1);
  }
  const tracer = new JobTracer(frontendRoot, allowedJobTypes);
  await tracer.scanRepository();
  tracer.jobTargets = loadJobTargetsFile(frontendRoot);
  if (strictRegistry && tracer.unknownJobTypes && tracer.unknownJobTypes.size > 0) {
    console.error('\nUnregistered job types detected in @.architecture blocks:');
    [...tracer.unknownJobTypes].sort().forEach(job => console.error(`  - ${job}`));
    process.exit(1);
  }
  
  // Execute command
  switch (command) {
    case 'search': {
      if (commandArgs.length === 0) {
        console.error('❌ Error: Please provide at least one job type to search for');
        process.exit(1);
      }
      
      const matchMode = commandArgs.includes('--all') ? 'all' : 'any';
      const jobTypes = commandArgs.filter(arg => !arg.startsWith('--'));
      const results = tracer.searchJobTypes(jobTypes, matchMode);
      
      if (commandArgs.includes('--json')) {
        const output = {
          query: jobTypes,
          matchMode,
          totalResults: results.length,
          results: results.map(arch => ({
            file: path.relative(frontendRoot, arch.filePath),
            jobs: arch.jobTypes,
            incoming: arch.incoming,
            processing: arch.processing,
            outgoing: arch.outgoing
          }))
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        tracer.displaySearchResults(results, jobTypes);
      }
      break;
    }
    
    case 'trace': {
      if (commandArgs.length === 0) {
        console.error('❌ Error: Please provide a job type to trace');
        process.exit(1);
      }
      
      const jobType = commandArgs[0];
      tracer.displayPipelineTrace(jobType);
      break;
    }
    
    case 'list': {
      const sortBy = commandArgs.includes('--sort') && commandArgs[commandArgs.indexOf('--sort') + 1]
        ? commandArgs[commandArgs.indexOf('--sort') + 1]
        : 'name';
      tracer.listAllJobTypes(sortBy);
      break;
    }
    
    case 'find': {
      if (commandArgs.length === 0) {
        console.error('❌ Error: Please provide a search query');
        process.exit(1);
      }
      
      const query = commandArgs[0];
      const matches = tracer.fuzzySearchJobs(query);
      
      console.log(`\n🔍 Fuzzy search for: '${query}'`);
      console.log(`📊 Found ${matches.length} matching job types:\n`);
      
      matches.forEach(match => {
        const count = tracer.jobIndex.get(match)?.length || 0;
        console.log(`   • ${match} (${count} file(s))`);
      });
      break;
    }

    case 'audit': {
      const jsonFlag = commandArgs.includes('--json');
      tracer.auditJobTargets(jsonFlag);
      break;
    }
    
    case 'export': {
      if (commandArgs.length === 0) {
        console.error('❌ Error: Please provide output filename');
        process.exit(1);
      }
      
      const outputFile = commandArgs[0];
      await tracer.exportJson(outputFile);
      break;
    }
    
    default:
      console.error(`❌ Unknown command: ${command}`);
      console.log('Run with --help for usage information');
      process.exit(1);
  }
  
  console.log();
}

function printHelp() {
  console.log(`
Job Type Tracer - Frontend Pipeline Analysis Tool

USAGE:
  node job_tracer.js <command> [arguments] [options]

COMMANDS:
  search <job_types...>     Search for files by job type(s)
  trace <job_type>          Trace complete pipeline for a job type
  list                      List all job types
  find <query>              Fuzzy search for job types
  audit                     Compare observed job counts to GOLD targets
  export <file>             Export architecture index as JSON

OPTIONS:
  --all                     Match ALL job types (AND logic) for search
  --sort <mode>             Sort mode for list (name|frequency)
  --json                    Output results as JSON (search, audit)
  --strict-registry         Require a job registry at ../Architecture/frontend_job_registry.yaml and enforce membership
  --help, -h                Show this help message

EXAMPLES:
  # Search for single job type
  node job_tracer.js search JOB_RENDER_MARKDOWN

  # Search for multiple job types (OR)
  node job_tracer.js search JOB_PARSE_JSON JOB_VALIDATE_SCHEMA

  # Search for files with ALL job types (AND)
  node job_tracer.js search JOB_PARSE_JSON JOB_VALIDATE_SCHEMA --all

  # Trace complete pipeline for a job type
  node job_tracer.js trace JOB_WS_SEND

  # Fuzzy search for job types
  node job_tracer.js find render

  # List all job types
  node job_tracer.js list

  # List job types by frequency
  node job_tracer.js list --sort frequency

  # Export architecture index as JSON
  node job_tracer.js export architecture_index.json
`);
}

// Run
main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});

