'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export theme-manager, accessibility utilities (ThemeManager, accessibilityManager, AccessibilityManager, KeyboardNavigationHelper) for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: renderer/*, application/* (barrel exports) --- {module_exports, javascript_object}
 * 
 * 
 * @module renderer/shared/utils/index
 * 
 * Shared Utilities - Barrel Export
 * ============================================================================
 * Centralized export for all shared utilities.
 */

// Theme management
const { themeManager, ThemeManager } = require('./theme-manager');

// Accessibility
const { 
  accessibilityManager, 
  AccessibilityManager,
  KeyboardNavigationHelper 
} = require('./accessibility');

// Export all
module.exports = {
  // Theme
  themeManager,
  ThemeManager,
  
  // Accessibility
  accessibilityManager,
  AccessibilityManager,
  KeyboardNavigationHelper
};

// Make available globally for debugging
if (typeof window !== 'undefined') {
  window.AetherUtils = module.exports;
  console.log('📦 Aether shared utilities loaded');
}

