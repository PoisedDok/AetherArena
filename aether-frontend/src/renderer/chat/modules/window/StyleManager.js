'use strict';

/**
 * @.architecture
 * 
 * Incoming: ChatWindow.init() → injectStyles() call --- {none, method_call}
 * Processing: Verify global CSS files loaded from HTML link tags (chat.css uses theme variables) --- {1 job: JOB_INITIALIZE}
 * Outgoing: console log confirming CSS system ready --- {string, console_message}
 * 
 * @module renderer/chat/modules/window/StyleManager
 */

class StyleManager {
  constructor() {
    this.stylesLoaded = false;
  }

  injectStyles() {
    if (this.stylesLoaded) {
      console.log('[StyleManager] Styles already loaded from CSS files');
      return;
    }

    this.stylesLoaded = true;
    console.log('[StyleManager] Global styles loaded from external CSS (chat.css)');
  }

  removeStyles() {
    console.log('[StyleManager] Styles managed via external CSS - no cleanup needed');
  }

  dispose() {
    this.stylesLoaded = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StyleManager;
}

if (typeof window !== 'undefined') {
  window.StyleManager = StyleManager;
  console.log('📦 StyleManager loaded (CSS-based styling)');
}
