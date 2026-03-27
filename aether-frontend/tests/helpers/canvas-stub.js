/**
 * Jest stub for `canvas` (node-canvas).
 *
 * Purpose:
 * - jsdom will try to `require("canvas")` if it is installed.
 * - In some environments `canvas` is present in node_modules but its native binary
 *   (`build/Release/canvas.node`) is not built, causing the entire test run to crash.
 * - This stub keeps tests hermetic and prevents native build requirements.
 *
 * NOTE: This is a TEST-ONLY module (wired via `jest.config.js` moduleNameMapper).
 */

'use strict';

function createCanvas(width = 0, height = 0) {
  return {
    width,
    height,
    getContext: () => null,
    toBuffer: () => Buffer.from([]),
  };
}

class Image {}

module.exports = {
  createCanvas,
  Image,
};

