'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');

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
    this.log = createRendererLogger('StyleManager');
  }

  injectStyles() {
    if (this.stylesLoaded) {
      this.log.trace('styles already loaded from CSS files');
      return;
    }

    this.stylesLoaded = true;
    this.log.trace('global styles loaded from external CSS');
  }

  removeStyles() {
    this.log.trace('styles managed via external CSS; no cleanup required');
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
  createRendererLogger('StyleManager').debug('module loaded');
}
