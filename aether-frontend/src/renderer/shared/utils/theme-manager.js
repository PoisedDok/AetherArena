'use strict';

/**
 * @.architecture
 *
 * Incoming: UI components (.setTheme/.toggleTheme calls), system (matchMedia change events) --- {method_calls | browser_event, javascript_api}
 * Processing: Theme management - detect system preference via matchMedia('prefers-color-scheme: dark'), resolve current theme from system/user preference, apply theme (set data-theme attr + dark/light class), notify subscribers, handle system preference changes, smooth transitions via theme-transitioning class --- {3 jobs: JOB_GET_STATE, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
 * Outgoing: Apply theme to document.documentElement (data-theme + classes), notify onChange subscribers --- {dom_update | event_emission, none}
 *
 *
 * @module renderer/shared/utils/theme-manager
 */

/**
 * ThemeManager - Theme management and toggling
 * ============================================================================
 * Manages application theme (dark/light mode) with:
 * - Theme detection (system preference)
 * - Theme switching with persistence
 * - Smooth transitions between themes
 * - Event emission for theme changes
 * 
 * Architecture:
 * - Singleton pattern
 * - LocalStorage persistence
 * - System preference detection
 * - Framework-agnostic
 * 
 * @module renderer/shared/utils/theme-manager
 */

const { freeze } = Object;
const { createRendererLogger } = require('./logger');

class ThemeManager {
  constructor() {
    this.log = createRendererLogger('ThemeManager');
    this.currentTheme = null;
    this.systemPreference = null;
    this.preference = 'system';
    this.listeners = [];
    
    this._detectSystemPreference();
    this._initializeTheme();
  }

  /**
   * Initialize theme manager
   */
  init() {
    // Apply initial theme
    this._applyTheme(this.currentTheme);
    
    // Listen for system theme changes
    if (typeof window !== 'undefined' && window.matchMedia) {
      this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this._boundHandleSystemPreferenceChange = this._handleSystemPreferenceChange.bind(this);
      
      // Modern API
      if (this._mediaQuery.addEventListener) {
        this._mediaQuery.addEventListener('change', this._boundHandleSystemPreferenceChange);
      } 
      // Legacy API
      else if (this._mediaQuery.addListener) {
        this._mediaQuery.addListener(this._boundHandleSystemPreferenceChange);
      }
    }
    
    this.log.debug('[ThemeManager] Initialized with theme:', this.currentTheme);
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this._mediaQuery && this._boundHandleSystemPreferenceChange) {
      if (this._mediaQuery.removeEventListener) {
        this._mediaQuery.removeEventListener('change', this._boundHandleSystemPreferenceChange);
      } else if (this._mediaQuery.removeListener) {
        this._mediaQuery.removeListener(this._boundHandleSystemPreferenceChange);
      }
    }
    this._mediaQuery = null;
    this._boundHandleSystemPreferenceChange = null;
    this.listeners = [];
    this.log.debug('[ThemeManager] Disposed');
  }

  /**
   * Get current theme
   * @returns {string} 'dark' or 'light'
   */
  getTheme() {
    return this.currentTheme;
  }

  /**
   * Set theme
   * @param {string} theme - 'dark', 'light', or 'system'
   */
  setTheme(theme) {
    if (!['dark', 'light', 'system'].includes(theme)) {
      this.log.error('[ThemeManager] Invalid theme:', theme);
      return;
    }

    this.log.debug('[ThemeManager] Setting theme:', theme);

    this.preference = theme;

    // If system, use detected preference
    const resolvedTheme = theme === 'system' ? this.systemPreference : theme;

    // Apply theme
    this._applyTheme(resolvedTheme);

    // Update current
    this.currentTheme = resolvedTheme;

    // Notify listeners
    this._notifyListeners(resolvedTheme);
  }

  /**
   * Toggle between dark and light
   */
  toggleTheme() {
    const newTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
    this.setTheme(newTheme);
  }

  /**
   * Check if dark mode
   * @returns {boolean}
   */
  isDarkMode() {
    return this.currentTheme === 'dark';
  }

  /**
   * Check if light mode
   * @returns {boolean}
   */
  isLightMode() {
    return this.currentTheme === 'light';
  }

  /**
   * Subscribe to theme changes
   * @param {Function} callback - Called with new theme
   * @returns {Function} Unsubscribe function
   */
  onChange(callback) {
    if (typeof callback !== 'function') {
      throw new Error('[ThemeManager] onChange callback must be a function');
    }

    this.listeners.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Get theme statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      currentTheme: this.currentTheme,
      systemPreference: this.systemPreference,
      listenerCount: this.listeners.length,
      isDarkMode: this.isDarkMode(),
      isLightMode: this.isLightMode()
    });
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Detect system color scheme preference
   * @private
   */
  _detectSystemPreference() {
    if (typeof window === 'undefined') {
      this.systemPreference = 'dark';
      return;
    }

    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      this.systemPreference = 'dark';
    } else {
      this.systemPreference = 'light';
    }

    this.log.debug('[ThemeManager] System preference:', this.systemPreference);
  }

  /**
   * Initialize theme from system preference
   * @private
   */
  _initializeTheme() {
    // Default preference is to follow system
    this.preference = 'system';
    this.currentTheme = this.systemPreference || 'dark';

    this.log.debug('[ThemeManager] Initialized theme from system preference:', this.currentTheme);
  }

  /**
   * Apply theme to document
   * @private
   * @param {string} theme - 'dark' or 'light'
   */
  _applyTheme(theme) {
    if (typeof document === 'undefined') {
      return;
    }

    // Add transition class for smooth theme change
    document.documentElement.classList.add('theme-transitioning');

    // Set data-theme attribute
    document.documentElement.setAttribute('data-theme', theme);

    // Also set class for backwards compatibility
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }

    // Remove transition class after transition completes
    setTimeout(() => {
      document.documentElement.classList.remove('theme-transitioning');
    }, 300);

    this.log.debug('[ThemeManager] Applied theme:', theme);
  }

  /**
   * Handle system preference change
   * @private
   * @param {MediaQueryListEvent} e - Event
   */
  _handleSystemPreferenceChange(e) {
    this.systemPreference = e.matches ? 'dark' : 'light';
    
    this.log.debug('[ThemeManager] System preference changed to:', this.systemPreference);

    // If user is following system theme, update applied theme accordingly
    if (this.preference === 'system') {
      const resolvedTheme = this.systemPreference;
      this._applyTheme(resolvedTheme);
      this.currentTheme = resolvedTheme;
      this._notifyListeners(resolvedTheme);
    }
  }

  /**
   * Notify all listeners of theme change
   * @private
   * @param {string} theme - New theme
   */
  _notifyListeners(theme) {
    this.listeners.forEach(callback => {
      try {
        callback(theme);
      } catch (error) {
        this.log.error('[ThemeManager] Listener error:', error);
      }
    });
  }
}

// Create singleton instance
const themeManager = new ThemeManager();

// Export singleton
module.exports = { themeManager, ThemeManager };

// Make available globally
if (typeof window !== 'undefined') {
  window.themeManager = themeManager;
}
