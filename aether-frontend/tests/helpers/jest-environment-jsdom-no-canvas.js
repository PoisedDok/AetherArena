/**
 * Custom Jest environment: jsdom without native node-canvas.
 *
 * Problem:
 * - jsdom will `require("canvas")` if it is installed.
 * - In some environments, the `canvas` package is present but its native binary
 *   (`build/Release/canvas.node`) is not built, crashing the entire Jest run.
 *
 * Fix:
 * - Prime Node's module cache for `canvas` BEFORE loading jest-environment-jsdom/jsdom,
 *   so jsdom sees a harmless stub and never tries to load the native binding.
 *
 * This is intentionally test-only and does not impact production runtime.
 */

'use strict';

// Prime the Node require cache for "canvas" before jsdom is loaded.
try {
  const canvasId = require.resolve('canvas');
  if (!require.cache[canvasId]) {
    // Minimal stub: jsdom only checks presence of createCanvas().
    const stub = {
      createCanvas: () => ({
        getContext: () => null,
        toBuffer: () => Buffer.from([]),
      }),
      Image: class Image {},
    };

    require.cache[canvasId] = {
      id: canvasId,
      filename: canvasId,
      loaded: true,
      exports: stub,
    };
  }
} catch (e) {
  // If canvas is not installed, nothing to do.
}

const JSDOMEnvironmentModule = require('jest-environment-jsdom');
const JSDOMEnvironment =
  JSDOMEnvironmentModule.default || JSDOMEnvironmentModule;

class NoCanvasJSDOMEnvironment extends JSDOMEnvironment {}

module.exports = NoCanvasJSDOMEnvironment;

