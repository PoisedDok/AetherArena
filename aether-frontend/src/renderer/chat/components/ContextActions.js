'use strict';

/**
 * @.architecture
 * 
 * Incoming: User clicks, context status --- {event.dom, Object}
 * Processing: Render action buttons, handle clicks --- {2 jobs: JOB_RENDER, JOB_ROUTE_BY_TYPE}
 * Outgoing: EventBus action events --- {event, json}
 * 
 * @module renderer/chat/components/ContextActions
 * 
 * ContextActions - Context Management Action Buttons
 * ==================================================
 * 
 * Provides action buttons for context management:
 * - Summarize: Manually trigger context summarization
 * - Export: Export context for cross-chat use
 * - New Chat: Start fresh chat (when critical)
 */

const { createRendererLogger } = require('../../shared/utils/logger');

class ContextActions {
  constructor(options = {}) {
    this.log = createRendererLogger('ContextActions');
    this.container = options.container || null;
    this.eventBus = options.eventBus || null;
    this.enableLogging = options.enableLogging || false;
    
    // State
    this.currentChatId = null;
    this.currentStatus = null;
    
    // DOM elements
    this.actionsContainer = null;
    this.summarizeBtn = null;
    this.exportBtn = null;
    this.newChatBtn = null;
    
    if (!this.container) {
      throw new Error('[ContextActions] container required');
    }
    
    this._init();
  }
  
  /**
   * Initialize actions
   * @private
   */
  _init() {
    // Create container
    this.actionsContainer = document.createElement('div');
    this.actionsContainer.className = 'context-actions';
    
    // Summarize button
    this.summarizeBtn = this._createButton({
      text: 'Summarize',
      title: 'Condense conversation context',
      onClick: () => this._handleSummarize()
    });
    
    // Export button
    this.exportBtn = this._createButton({
      text: 'Export',
      title: 'Export context for cross-chat use',
      onClick: () => this._handleExport()
    });
    
    // New chat button (only shown when critical)
    this.newChatBtn = this._createButton({
      text: 'New Chat',
      title: 'Start fresh conversation',
      onClick: () => this._handleNewChat(),
      variant: 'primary'
    });
    
    // Add buttons to container
    this.actionsContainer.appendChild(this.summarizeBtn);
    this.actionsContainer.appendChild(this.exportBtn);
    this.actionsContainer.appendChild(this.newChatBtn);
    
    // Add to parent container
    this.container.appendChild(this.actionsContainer);
    
    if (this.enableLogging) {
      this.log.debug('[ContextActions] Initialized');
    }
  }
  
  /**
   * Create action button
   * @param {Object} options - Button options
   * @returns {HTMLElement} Button element
   * @private
   */
  _createButton({ text, title, onClick, variant = 'default' }) {
    const button = document.createElement('button');
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.className = `context-action-btn context-action-btn-${variant}`;
    
    // Styles handled via CSS classes: .context-action-btn, .context-action-btn-primary
    // Hover effects handled via CSS: .context-action-btn:hover
    
    button.addEventListener('click', onClick);
    
    return button;
  }
  
  /**
   * Update actions based on context status
   * @param {string} chatId - Current chat ID
   * @param {Object} status - Context status
   */
  update(chatId, status) {
    this.currentChatId = chatId;
    this.currentStatus = status;
    
    if (!status) {
      this.hide();
      return;
    }
    
    const statusLevel = status.status || 'normal';
    
    // Show actions for warning and above
    if (['warning', 'high', 'critical'].includes(statusLevel)) {
      this.show();
      
      // Show new chat button only for critical
      this.newChatBtn.style.display = statusLevel === 'critical' ? 'inline-block' : 'none';
      
      // Disable summarize if already at minimum
      const canSummarize = (status.message_count || status.messageCount || 0) > 10;
      this.summarizeBtn.disabled = !canSummarize;
      this.summarizeBtn.style.opacity = canSummarize ? '1' : '0.5';
      
    } else {
      this.hide();
    }
    
    if (this.enableLogging) {
      this.log.debug('[ContextActions] Updated:', { chatId: chatId?.substring(0, 8), statusLevel });
    }
  }
  
  /**
   * Handle summarize action
   * @private
   */
  _handleSummarize() {
    if (!this.currentChatId) return;
    
    if (this.enableLogging) {
      this.log.debug('[ContextActions] Summarize clicked');
    }
    
    if (this.eventBus) {
      this.eventBus.emit('context:action:summarize', {
        chatId: this.currentChatId,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Handle export action
   * @private
   */
  _handleExport() {
    if (!this.currentChatId) return;
    
    if (this.enableLogging) {
      this.log.debug('[ContextActions] Export clicked');
    }
    
    if (this.eventBus) {
      this.eventBus.emit('context:action:export', {
        chatId: this.currentChatId,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Handle new chat action
   * @private
   */
  _handleNewChat() {
    if (this.enableLogging) {
      this.log.debug('[ContextActions] New chat clicked');
    }
    
    if (this.eventBus) {
      this.eventBus.emit('context:action:new-chat', {
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Hide actions
   */
  hide() {
    if (this.actionsContainer) {
      this.actionsContainer.style.display = 'none';
    }
  }
  
  /**
   * Show actions
   */
  show() {
    if (this.actionsContainer) {
      this.actionsContainer.style.display = 'flex';
    }
  }
  
  /**
   * Cleanup
   */
  destroy() {
    if (this.actionsContainer && this.actionsContainer.parentNode) {
      this.actionsContainer.parentNode.removeChild(this.actionsContainer);
    }
    
    this.actionsContainer = null;
    this.summarizeBtn = null;
    this.exportBtn = null;
    this.newChatBtn = null;
    
    if (this.enableLogging) {
      this.log.debug('[ContextActions] Destroyed');
    }
  }
}

module.exports = { ContextActions };
