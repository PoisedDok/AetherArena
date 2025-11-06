#!/usr/bin/env node
/**
 * Preload Script Bundler
 * ============================================================================
 * Bundles preload scripts with esbuild for secure context-isolated execution.
 * 
 * Why bundling:
 * - Preload scripts with contextIsolation:true cannot use require() for relative paths
 * - All dependencies must be bundled into single file
 * - Maintains security while allowing modular development
 * 
 * Security:
 * - Targets Node.js environment (not browser)
 * - Maintains Electron API access
 * - All code statically analyzed and bundled
 * - Tree-shaking removes unused code
 * - Minification in production
 * 
 * @module scripts/bundle-preload
 */

import * as esbuild from 'esbuild';
import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src');
const buildDir = join(rootDir, 'build/preload');

// ============================================================================
// Configuration
// ============================================================================

const isDev = process.env.NODE_ENV !== 'production';
const watch = process.argv.includes('--watch');

console.log('🔧 Preload Bundler');
console.log('  Mode:', isDev ? 'development' : 'production');
console.log('  Watch:', watch);
console.log('');

// Preload entry points
const entryPoints = [
  {
    name: 'main-preload',
    in: join(srcDir, 'preload/main-preload.js'),
    out: join(buildDir, 'main-preload'),
  },
  {
    name: 'chat-preload',
    in: join(srcDir, 'preload/chat-preload.js'),
    out: join(buildDir, 'chat-preload'),
  },
  {
    name: 'artifacts-preload',
    in: join(srcDir, 'preload/artifacts-preload.js'),
    out: join(buildDir, 'artifacts-preload'),
  },
];

// ============================================================================
// Build Configuration
// ============================================================================

const baseConfig = {
  bundle: true,
  platform: 'node', // Preload scripts run in Node.js context
  target: 'node18', // Node.js 18+ for Electron 25
  format: 'cjs', // CommonJS for Node.js
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  treeShaking: true,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
  },
  // External modules provided by Electron (do not bundle)
  external: ['electron'],
};

// ============================================================================
// Bundle Function
// ============================================================================

async function bundlePreload(entry) {
  console.log(`📦 Bundling ${entry.name}...`);
  
  try {
    // Ensure output directory exists
    if (!existsSync(dirname(entry.out))) {
      mkdirSync(dirname(entry.out), { recursive: true });
    }
    
    const config = {
      ...baseConfig,
      entryPoints: [entry.in],
      outfile: entry.out + '.js',
    };
    
    if (watch) {
      // Watch mode
      const ctx = await esbuild.context(config);
      await ctx.watch();
      console.log(`✅ ${entry.name} bundled (watching...)`);
      return ctx;
    } else {
      // One-time build
      const result = await esbuild.build(config);
      console.log(`✅ ${entry.name} bundled`);
      
      if (result.metafile) {
        const analysis = await esbuild.analyzeMetafile(result.metafile);
        console.log(analysis);
      }
      
      return result;
    }
  } catch (error) {
    console.error(`❌ Failed to bundle ${entry.name}:`, error);
    throw error;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  try {
    const contexts = [];
    
    for (const entry of entryPoints) {
      const result = await bundlePreload(entry);
      if (watch && result) {
        contexts.push(result);
      }
    }
    
    if (watch) {
      console.log('');
      console.log('👀 Watching for changes... (Press Ctrl+C to stop)');
      
      // Keep process alive
      process.on('SIGINT', async () => {
        console.log('\n🛑 Stopping watchers...');
        for (const ctx of contexts) {
          await ctx.dispose();
        }
        process.exit(0);
      });
    } else {
      console.log('');
      console.log('✨ All preload scripts bundled successfully!');
      console.log(`📁 Output: ${buildDir}/`);
    }
  } catch (error) {
    console.error('');
    console.error('❌ Bundle failed:', error);
    process.exit(1);
  }
}

main();

