#!/usr/bin/env node
/**
 * Renderer Bundler
 * ============================================================================
 * Bundles renderer scripts with esbuild for secure context-isolated execution.
 * 
 * Why bundling:
 * - Renderer processes cannot use require() with contextIsolation:true
 * - Must bundle all CommonJS dependencies into single browser-compatible file
 * - Maintains security while allowing modular development
 * 
 * Security:
 * - No eval or new Function
 * - All code statically analyzed and bundled
 * - Tree-shaking removes unused code
 * - Minification in production
 * 
 * @module scripts/bundle-renderers
 */

import * as esbuild from 'esbuild';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src');
const buildDir = join(rootDir, 'build/renderer');

// ============================================================================
// Configuration
// ============================================================================

const isDev = process.env.NODE_ENV !== 'production';
const watch = process.argv.includes('--watch');

console.log('🔧 Renderer Bundler');
console.log('  Mode:', isDev ? 'development' : 'production');
console.log('  Watch:', watch);
console.log('');

// Renderer entry points
  const entryPoints = [
    {
      name: 'main',
      in: join(srcDir, 'renderer/main/main-renderer.js'),
      out: join(buildDir, 'main'),
    },
    {
      name: 'chat',
      in: join(srcDir, 'renderer/chat/renderer.js'),
      out: join(buildDir, 'chat'),
    },
  {
    name: 'artifacts',
    in: join(srcDir, 'renderer/artifacts/renderer.js'),
    out: join(buildDir, 'artifacts'),
  },
  ];

// ============================================================================
// Build Configuration
// ============================================================================

const baseConfig = {
  bundle: true,
  platform: 'browser',
  target: 'chrome108', // Electron 25 uses Chromium 108
  format: 'iife', // Immediately Invoked Function Expression for browser
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  treeShaking: true,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
  },
  // External modules that shouldn't be bundled (renderer doesn't need main process modules)
  external: ['electron', 'path', 'fs', 'os', 'crypto', 'child_process', 'net', 'http', 'https'],
};

// ============================================================================
// Bundle Function
// ============================================================================

async function bundleRenderer(entry) {
  console.log(`📦 Bundling ${entry.name} renderer...`);
  
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
      const result = await bundleRenderer(entry);
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
      console.log('✨ All renderers bundled successfully!');
      console.log(`📁 Output: ${buildDir}/`);
    }
  } catch (error) {
    console.error('');
    console.error('❌ Bundle failed:', error);
    process.exit(1);
  }
}

main();

