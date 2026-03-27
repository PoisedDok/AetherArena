'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');

/**
 * @.architecture
 * 
 * Incoming: Module initialization (init()) --- {method_call, javascript_api}
 * Processing: Verify global CSS files loaded from HTML link tags (chat.css uses theme variables) --- {1 job: JOB_INITIALIZE}
 * Outgoing: console log confirming CSS system ready --- {string, console_message}
 * 
 * @module renderer/chat/modules/trail/TrailStyleManager
 */

class TrailStyleManager {
  constructor(options = {}) {
    this.styleId = options.styleId || 'artifact-trail-styles';
    this.injected = false;
    this.log = createRendererLogger('TrailStyleManager');
  }
  
  inject() {
    if (this.injected) {
      return;
    }
    
    this.injected = true;
    this.log.trace('styles loaded from external CSS');
  }
  
  remove() {
    this.log.trace('styles managed via external CSS; no cleanup required');
    this.injected = false;
  }
  
  dispose() {
    this.remove();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrailStyleManager;
}

if (typeof window !== 'undefined') {
  window.TrailStyleManager = TrailStyleManager;
  createRendererLogger('TrailStyleManager').debug('module loaded');
}
