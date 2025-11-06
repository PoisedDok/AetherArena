'use strict';

/**
 * @.architecture
 *
 * Incoming: UI components (.setTheme/.toggleTheme calls), system (matchMedia change events) --- {method_calls | browser_event, javascript_api}
 * Processing: Theme management - detect system preference via matchMedia('prefers-color-scheme: dark'), load from localStorage, apply theme (set data-theme attr + dark/light class), save to localStorage, notify subscribers, handle system preference changes, smooth transitions via theme-transitioning class --- {5 jobs: JOB_GET_STATE, JOB_LOAD_FROM_DB, JOB_UPDATE_STATE, JOB_SAVE_TO_DB, JOB_EMIT_EVENT}
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

class ThemeManager {
  constructor() {
    this.currentTheme = null;
    this.systemPreference = null;
    this.listeners = [];
    this.storageKey = 'aether-theme';
    
    this._detectSystemPreference();
    this._loadSavedTheme();
  }

  /**
   * Initialize theme manager
   */
  init() {
    // Apply initial theme
    this._applyTheme(this.currentTheme);
    
    // Listen for system theme changes
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      
      // Modern API
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', this._handleSystemPreferenceChange.bind(this));
      } 
      // Legacy API
      else if (mediaQuery.addListener) {
        mediaQuery.addListener(this._handleSystemPreferenceChange.bind(this));
      }
    }
    
    console.log('[ThemeManager] Initialized with theme:', this.currentTheme);
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
      console.error('[ThemeManager] Invalid theme:', theme);
      return;
    }

    console.log('[ThemeManager] Setting theme:', theme);

    // If system, use detected preference
    const resolvedTheme = theme === 'system' ? this.systemPreference : theme;

    // Apply theme
    this._applyTheme(resolvedTheme);

    // Save preference
    this._saveTheme(theme);

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

    console.log('[ThemeManager] System preference:', this.systemPreference);
  }

  /**
   * Load saved theme from localStorage
   * @private
   */
  _loadSavedTheme() {
    if (typeof window === 'undefined' || !window.localStorage) {
      this.currentTheme = 'dark'; // Default
      return;
    }

    try {
      const saved = window.localStorage.getItem(this.storageKey);
      
      if (saved === 'system') {
        this.currentTheme = this.systemPreference;
      } else if (saved === 'dark' || saved === 'light') {
        this.currentTheme = saved;
      } else {
        // No saved preference, use system
        this.currentTheme = this.systemPreference;
      }
    } catch (error) {
      console.error('[ThemeManager] Failed to load saved theme:', error);
      this.currentTheme = 'dark';
    }

    console.log('[ThemeManager] Loaded theme:', this.currentTheme);
  }

  /**
   * Save theme preference to localStorage
   * @private
   * @param {string} theme - Theme to save
   */
  _saveTheme(theme) {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }

    try {
      window.localStorage.setItem(this.storageKey, theme);
    } catch (error) {
      console.error('[ThemeManager] Failed to save theme:', error);
    }
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

    console.log('[ThemeManager] Applied theme:', theme);
  }

  /**
   * Handle system preference change
   * @private
   * @param {MediaQueryListEvent} e - Event
   */
  _handleSystemPreferenceChange(e) {
    this.systemPreference = e.matches ? 'dark' : 'light';
    
    console.log('[ThemeManager] System preference changed to:', this.systemPreference);

    // If user is using system theme, update
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const saved = window.localStorage.getItem(this.storageKey);
        if (saved === 'system' || !saved) {
          this.setTheme('system');
        }
      } catch (error) {
        console.error('[ThemeManager] Failed to check saved theme:', error);
      }
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
        console.error('[ThemeManager] Listener error:', error);
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
  console.log('📦 ThemeManager loaded');
}

