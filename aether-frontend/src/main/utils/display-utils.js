'use strict';

/**
 * @.architecture
 * 
 * Incoming: Window bounds {x, y, width, height} from callers --- {bounds_object, javascript_object}
 * Processing: Calculate positions (widget bottom-right, centered, offset, optimal near cursor), constrain to work area, ensure visibility, handle multiple displays, convert logical/physical pixels, query screen API (getAllDisplays, getPrimaryDisplay, getDisplayForBounds, getCursorScreenPoint, getDisplayNearestPoint), provide 15+ utility functions --- {5 jobs: JOB_GET_STATE, JOB_GET_STATE, JOB_LOAD_FROM_DB, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA}
 * Outgoing: Window bounds {x, y, width, height} --- {bounds_object, javascript_object}
 * 
 * 
 * @module main/utils/display-utils
 * 
 * Display and Screen Utilities
 * ============================================================================
 * Utilities for calculating window positions, handling multiple displays,
 * and managing window geometry.
 * 
 * @module main/utils/display-utils
 */

const { screen } = require('electron');

/**
 * Get the display containing a given window bounds
 * @param {Object} bounds - Window bounds {x, y, width, height}
 * @returns {Electron.Display} Display object
 */
function getDisplayForBounds(bounds) {
  return screen.getDisplayMatching(bounds);
}

/**
 * Get all available displays
 * @returns {Electron.Display[]} Array of displays
 */
function getAllDisplays() {
  return screen.getAllDisplays();
}

/**
 * Get primary display
 * @returns {Electron.Display} Primary display
 */
function getPrimaryDisplay() {
  return screen.getPrimaryDisplay();
}

/**
 * Calculate widget position (bottom-right corner with margin)
 * @param {Object} currentBounds - Current window bounds
 * @param {number} widgetSize - Widget size (square)
 * @param {number} margin - Margin from screen edge
 * @returns {Object} Position {x, y, width, height}
 */
function calculateWidgetPosition(currentBounds, widgetSize, margin = 24) {
  try {
    const display = getDisplayForBounds(currentBounds);
    const { workArea } = display;
    
    // Calculate position (bottom-right corner)
    const x = Math.max(
      workArea.x + margin,
      workArea.x + workArea.width - widgetSize - margin
    );
    const y = Math.max(
      workArea.y + margin,
      workArea.y + workArea.height - widgetSize - margin
    );
    
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: widgetSize,
      height: widgetSize,
    };
  } catch (err) {
    console.error('[DisplayUtils] Failed to calculate widget position:', err);
    // Fallback to simple positioning
    return {
      x: 100,
      y: 100,
      width: widgetSize,
      height: widgetSize,
    };
  }
}

/**
 * Calculate centered window position
 * @param {number} width - Window width
 * @param {number} height - Window height
 * @param {Electron.Display} [display] - Target display (default: primary)
 * @returns {Object} Position {x, y, width, height}
 */
function calculateCenteredPosition(width, height, display = null) {
  try {
    const targetDisplay = display || getPrimaryDisplay();
    const { workArea } = targetDisplay;
    
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = Math.round(workArea.y + (workArea.height - height) / 2);
    
    return {
      x: Math.max(workArea.x, x),
      y: Math.max(workArea.y, y),
      width,
      height,
    };
  } catch (err) {
    console.error('[DisplayUtils] Failed to calculate centered position:', err);
    return { x: 100, y: 100, width, height };
  }
}

/**
 * Ensure bounds are visible on screen (adjust if off-screen)
 * @param {Object} bounds - Window bounds {x, y, width, height}
 * @returns {Object} Adjusted bounds
 */
function ensureBoundsVisible(bounds) {
  try {
    const displays = getAllDisplays();
    
    // Check if bounds intersect with any display
    const isVisible = displays.some(display => {
      const { workArea } = display;
      return (
        bounds.x + bounds.width > workArea.x &&
        bounds.x < workArea.x + workArea.width &&
        bounds.y + bounds.height > workArea.y &&
        bounds.y < workArea.y + workArea.height
      );
    });
    
    if (isVisible) {
      return bounds;
    }
    
    // If not visible, move to primary display
    const primaryDisplay = getPrimaryDisplay();
    const { workArea } = primaryDisplay;
    
    return {
      x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width)),
      y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height)),
      width: bounds.width,
      height: bounds.height,
    };
  } catch (err) {
    console.error('[DisplayUtils] Failed to ensure bounds visible:', err);
    return bounds;
  }
}

/**
 * Constrain bounds to work area (prevent window from being off-screen)
 * @param {Object} bounds - Window bounds
 * @param {Electron.Display} [display] - Target display
 * @returns {Object} Constrained bounds
 */
function constrainToWorkArea(bounds, display = null) {
  try {
    const targetDisplay = display || getDisplayForBounds(bounds);
    const { workArea } = targetDisplay;
    
    return {
      x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width)),
      y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height)),
      width: Math.min(bounds.width, workArea.width),
      height: Math.min(bounds.height, workArea.height),
    };
  } catch (err) {
    console.error('[DisplayUtils] Failed to constrain to work area:', err);
    return bounds;
  }
}

/**
 * Calculate offset position relative to another window
 * @param {Object} anchorBounds - Anchor window bounds
 * @param {number} width - New window width
 * @param {number} height - New window height
 * @param {Object} offset - Offset {x, y} (default: {x: 20, y: 20})
 * @returns {Object} Position {x, y, width, height}
 */
function calculateOffsetPosition(anchorBounds, width, height, offset = { x: 20, y: 20 }) {
  try {
    const x = anchorBounds.x + offset.x;
    const y = anchorBounds.y + offset.y;
    
    const bounds = { x, y, width, height };
    
    // Ensure new window is visible
    return ensureBoundsVisible(bounds);
  } catch (err) {
    console.error('[DisplayUtils] Failed to calculate offset position:', err);
    return { x: 100, y: 100, width, height };
  }
}

/**
 * Get mouse cursor position
 * @returns {Object} Position {x, y}
 */
function getCursorPosition() {
  try {
    return screen.getCursorScreenPoint();
  } catch (err) {
    console.error('[DisplayUtils] Failed to get cursor position:', err);
    return { x: 0, y: 0 };
  }
}

/**
 * Get display at cursor position
 * @returns {Electron.Display} Display at cursor
 */
function getDisplayAtCursor() {
  try {
    const cursorPos = getCursorPosition();
    return screen.getDisplayNearestPoint(cursorPos);
  } catch (err) {
    console.error('[DisplayUtils] Failed to get display at cursor:', err);
    return getPrimaryDisplay();
  }
}

/**
 * Calculate optimal window position (near cursor, but fully visible)
 * @param {number} width - Window width
 * @param {number} height - Window height
 * @param {Object} [offset] - Offset from cursor {x, y}
 * @returns {Object} Position {x, y, width, height}
 */
function calculateOptimalPosition(width, height, offset = { x: 10, y: 10 }) {
  try {
    const cursorPos = getCursorPosition();
    const display = getDisplayAtCursor();
    const { workArea } = display;
    
    let x = cursorPos.x + offset.x;
    let y = cursorPos.y + offset.y;
    
    // Ensure window fits in work area
    if (x + width > workArea.x + workArea.width) {
      x = workArea.x + workArea.width - width - offset.x;
    }
    if (y + height > workArea.y + workArea.height) {
      y = workArea.y + workArea.height - height - offset.y;
    }
    
    // Ensure minimum position
    x = Math.max(workArea.x, x);
    y = Math.max(workArea.y, y);
    
    return {
      x: Math.round(x),
      y: Math.round(y),
      width,
      height,
    };
  } catch (err) {
    console.error('[DisplayUtils] Failed to calculate optimal position:', err);
    return calculateCenteredPosition(width, height);
  }
}

/**
 * Get display scale factor
 * @param {Electron.Display} [display] - Target display
 * @returns {number} Scale factor
 */
function getScaleFactor(display = null) {
  try {
    const targetDisplay = display || getPrimaryDisplay();
    return targetDisplay.scaleFactor;
  } catch (err) {
    console.error('[DisplayUtils] Failed to get scale factor:', err);
    return 1.0;
  }
}

/**
 * Convert logical pixels to physical pixels
 * @param {number} logicalPixels - Logical pixel value
 * @param {Electron.Display} [display] - Target display
 * @returns {number} Physical pixel value
 */
function toPhysicalPixels(logicalPixels, display = null) {
  const scaleFactor = getScaleFactor(display);
  return Math.round(logicalPixels * scaleFactor);
}

/**
 * Convert physical pixels to logical pixels
 * @param {number} physicalPixels - Physical pixel value
 * @param {Electron.Display} [display] - Target display
 * @returns {number} Logical pixel value
 */
function toLogicalPixels(physicalPixels, display = null) {
  const scaleFactor = getScaleFactor(display);
  return Math.round(physicalPixels / scaleFactor);
}

/**
 * Check if bounds are within display bounds
 * @param {Object} bounds - Window bounds
 * @param {Electron.Display} [display] - Target display
 * @returns {boolean} True if bounds are within display
 */
function isWithinDisplay(bounds, display = null) {
  try {
    const targetDisplay = display || getDisplayForBounds(bounds);
    const { workArea } = targetDisplay;
    
    return (
      bounds.x >= workArea.x &&
      bounds.y >= workArea.y &&
      bounds.x + bounds.width <= workArea.x + workArea.width &&
      bounds.y + bounds.height <= workArea.y + workArea.height
    );
  } catch (err) {
    console.error('[DisplayUtils] Failed to check if within display:', err);
    return false;
  }
}

/**
 * Get available work area for a display
 * @param {Electron.Display} [display] - Target display
 * @returns {Object} Work area {x, y, width, height}
 */
function getWorkArea(display = null) {
  try {
    const targetDisplay = display || getPrimaryDisplay();
    return targetDisplay.workArea;
  } catch (err) {
    console.error('[DisplayUtils] Failed to get work area:', err);
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Display queries
  getDisplayForBounds,
  getAllDisplays,
  getPrimaryDisplay,
  getDisplayAtCursor,
  getCursorPosition,
  getWorkArea,
  
  // Position calculations
  calculateWidgetPosition,
  calculateCenteredPosition,
  calculateOffsetPosition,
  calculateOptimalPosition,
  
  // Bounds utilities
  ensureBoundsVisible,
  constrainToWorkArea,
  isWithinDisplay,
  
  // Scale utilities
  getScaleFactor,
  toPhysicalPixels,
  toLogicalPixels,
};

