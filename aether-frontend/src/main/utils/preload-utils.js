'use strict';

/**
 * @.architecture
 *
 * Incoming: main/windows/*.js --- {__dirname, preload_name}
 * Processing: Resolve the correct preload entrypoint for the current runtime (prefer bundled build preloads in dev/prod; fall back to src only if build is absent) --- {1 job: JOB_RESOLVE_PATH}
 * Outgoing: Absolute preload file path --- {string, filesystem_path}
 *
 * @module main/utils/preload-utils
 */

const fs = require('fs');
const path = require('path');

/**
 * Resolve preload file path.
 *
 * Why:
 * - Electron sandboxed preload execution expects a *single-file* preload bundle (internal require is restricted).
 * - Our dev workflow already runs `npm run build:preload`, so `build/preload/*` is the correct source of truth.
 * - We keep a last-resort fallback to `src/preload/*` only when build artifacts are absent.
 *
 * @param {string} windowModuleDir - `__dirname` from a window module in `src/main/windows/`
 * @param {string} preloadFilename - e.g. 'main-preload.js'
 * @returns {string} absolute path to preload JS
 */
function resolvePreloadPath(windowModuleDir, preloadFilename) {
  if (!windowModuleDir || typeof windowModuleDir !== 'string') {
    throw new Error('[PreloadUtils] windowModuleDir must be a non-empty string');
  }
  if (!preloadFilename || typeof preloadFilename !== 'string') {
    throw new Error('[PreloadUtils] preloadFilename must be a non-empty string');
  }

  const srcPath = path.join(windowModuleDir, '../../preload', preloadFilename);
  const buildPath = path.join(windowModuleDir, '../../../build/preload', preloadFilename);

  const isDev =
    process.env.ELECTRON_DEV === 'true' ||
    process.env.NODE_ENV === 'development';

  // Prefer build output when it exists (dev + packaged)
  if (fs.existsSync(buildPath)) {
    return buildPath;
  }

  // Fail-fast in dev: if build is missing, something is wrong with the dev pipeline.
  if (isDev) {
    throw new Error(`[PreloadUtils] Missing bundled preload at ${buildPath} (dev requires build:preload)`);
  }

  // Last-resort fallback to src for environments that ship sources without build artifacts
  return srcPath;
}

module.exports = {
  resolvePreloadPath,
};

