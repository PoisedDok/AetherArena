'use strict';

/**
 * @.architecture
 * 
 * Incoming: StreamHandler.updateMessage(), MessageManager.renderMessage() (method calls with message objects) --- {message_types.user_message | message_types.assistant_message, javascript_object}
 * Processing: Render markdown for assistant (via MarkdownRenderer), escape HTML for user (via SecuritySanitizer), create DOM elements with chat-entry class, append to container, prune old messages (max 500), auto-scroll --- {5 jobs: JOB_RENDER_MARKDOWN, JOB_ESCAPE_HTML, JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_STATE, JOB_SCROLL_TO_BOTTOM}
 * Outgoing: DOM container (.aether-chat-content) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/chat/modules/messaging/MessageView
 */

const MarkdownRenderer = require('./MarkdownRenderer');
const SecuritySanitizer = require('./SecuritySanitizer');

class MessageView {
  constructor(options = {}) {
    // Dependencies
    this.markdownRenderer = options.markdownRenderer || new MarkdownRenderer();
    this.securitySanitizer = options.securitySanitizer || new SecuritySanitizer();
    this.eventBus = options.eventBus || null;

    // DOM references
    this.contentElement = null;

    // Configuration
    this.maxMessages = options.maxMessages || 500;
    this.autoScroll = options.autoScroll !== false;

    // State
    this.messageElements = new Map(); // messageId -> DOM element
    this._scrollRaf = null;

    console.log('[MessageView] Constructed');
  }

  /**
   * Initialize with content element
   * @param {HTMLElement} contentElement - Content container element
   */
  init(contentElement) {
    if (!contentElement) {
      throw new Error('[MessageView] Content element required');
    }

    this.contentElement = contentElement;
    console.log('[MessageView] Initialized');
  }

  /**
   * Render a single message
   * @param {Object} message - Message object
   * @param {string} message.id - Message ID
   * @param {string} message.content - Message content
   * @param {string} message.role - Message role (user|assistant|system)
   * @param {string} message.timestamp - ISO timestamp
   * @param {Object} message.attachments - Optional attachments
   */
  renderMessage(message) {
    if (!this.contentElement) {
      console.warn('[MessageView] Cannot render - not initialized');
      return null;
    }

    if (!message) {
      console.warn('[MessageView] Invalid message:', message);
      return null;
    }

    if (!message.content && message.role !== 'assistant') {
      console.warn('[MessageView] Invalid message (empty content for non-assistant):', message);
      return null;
    }

    const entry = document.createElement('div');
    entry.className = 'chat-entry';
    entry.dataset.messageId = message.id || this._generateTempId();
    entry.dataset.role = message.role || 'system';

    const timestamp = this._formatTimestamp(message.timestamp);
    const contentHTML = this._renderContent(message.content, message.role);
    const timestampHTML = message.role === 'user' 
      ? `<div class="chat-timestamp">${timestamp}</div>`
      : '';

    entry.innerHTML = `
      ${timestampHTML}
      <div class="chat-text ${message.role}">${contentHTML}</div>
    `;

    this.contentElement.appendChild(entry);

    if (message.id) {
      this.messageElements.set(message.id, entry);
    }

    this._pruneMessages();

    if (this.autoScroll) {
      this.scrollToBottom();
    }

    console.log(`[MessageView] Rendered ${message.role} message:`, message.id);
    return entry;
  }

  /**
   * Render a message with attachments
   * @param {Object} message - Message object
   * @param {Object} attachments - Attachments object
   * @param {string} attachments.imageBase64 - Base64 image data
   * @param {Array} attachments.files - File objects
   */
  renderMessageWithAttachments(message, attachments) {
    if (!this.contentElement) {
      console.warn('[MessageView] Cannot render - not initialized');
      return null;
    }

    // Create message entry
    const entry = document.createElement('div');
    entry.className = 'chat-entry';
    entry.dataset.messageId = message.id || this._generateTempId();
    entry.dataset.role = 'user'; // Attachments are always from user

    // Format timestamp
    const timestamp = this._formatTimestamp(message.timestamp);

    // Build preview HTML
    let previewHTML = '';

    // Image preview
    if (attachments.imageBase64) {
      previewHTML += `
        <div class="attachment-preview">
          <img 
            src="${attachments.imageBase64}" 
            alt="Attached image" 
            class="attached-image"
          />
        </div>
      `;
    }

    // File list
    if (attachments.files && attachments.files.length > 0) {
      const fileCount = attachments.files.length;
      previewHTML += `
        <div class="attachment-preview file-list-preview">
          <div class="file-attachment-icon">📎</div>
          <div class="file-attachment-details">
            <span>${fileCount} file${fileCount > 1 ? 's' : ''} attached</span>
            <ul class="inline-file-list">
              ${attachments.files.map(file => 
                `<li>${this.securitySanitizer.escapeHTML(file.name)}</li>`
              ).join('')}
            </ul>
          </div>
        </div>
      `;
    }

    // Message content
    const contentHTML = message.content
      ? `<div class="chat-text user">${this.securitySanitizer.escapeHTML(message.content)}</div>`
      : '';

    // Build complete HTML
    entry.innerHTML = `
      <div class="chat-timestamp">${timestamp}</div>
      ${contentHTML}
      ${previewHTML}
    `;

    // Append to content
    this.contentElement.appendChild(entry);

    // Track element
    if (message.id) {
      this.messageElements.set(message.id, entry);
    }

    // Prune and scroll
    this._pruneMessages();
    if (this.autoScroll) {
      this.scrollToBottom();
    }

    console.log(`[MessageView] Rendered message with attachments:`, message.id);
    return entry;
  }

  /**
   * Update an existing message
   * @param {string} messageId - Message ID
   * @param {string} content - New content
   */
  updateMessage(messageId, content) {
    const entry = this.messageElements.get(messageId);
    if (!entry) {
      console.warn(`[MessageView] Message not found for update: ${messageId}`);
      return false;
    }

    const role = entry.dataset.role || 'system';
    const textElement = entry.querySelector('.chat-text');

    if (textElement) {
      const contentHTML = this._renderContent(content, role);
      textElement.innerHTML = contentHTML;
      console.log(`[MessageView] Updated message: ${messageId}`);
      return true;
    }

    return false;
  }

  /**
   * Remove a message
   * @param {string} messageId - Message ID
   */
  removeMessage(messageId) {
    const entry = this.messageElements.get(messageId);
    if (entry && entry.parentNode) {
      entry.parentNode.removeChild(entry);
      this.messageElements.delete(messageId);
      console.log(`[MessageView] Removed message: ${messageId}`);
      return true;
    }
    return false;
  }

  /**
   * Clear all messages
   */
  clear() {
    if (this.contentElement) {
      this.contentElement.innerHTML = '';
    }
    this.messageElements.clear();
    console.log('[MessageView] Cleared all messages');
  }

  showEmptyState() {
    if (!this.contentElement) {
      return;
    }

    const emptyState = document.createElement('div');
    emptyState.className = 'chat-empty-state';
    emptyState.style.cssText = `
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: rgba(255, 255, 255, 0.4);
      font-size: 14px;
      text-align: center;
      padding: 20px;
    `;
    
    emptyState.innerHTML = `
      <div style="font-size: 48px; margin-bottom: 16px; opacity: 0.3;">💬</div>
      <div style="font-weight: 500; margin-bottom: 8px;">No messages yet</div>
      <div style="font-size: 12px; opacity: 0.7;">Start a conversation by typing a message below</div>
    `;

    this.contentElement.appendChild(emptyState);
    console.log('[MessageView] Showing empty state');
  }

  /**
   * Scroll to bottom
   */
  scrollToBottom() {
    if (!this.contentElement) return;

    // Cancel pending scroll
    if (this._scrollRaf) {
      cancelAnimationFrame(this._scrollRaf);
    }

    // Schedule scroll on next frame
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = null;
      if (this.contentElement) {
        this.contentElement.scrollTop = this.contentElement.scrollHeight;
      }
    });
  }

  /**
   * Render content based on role
   * @private
   * @param {string} content - Message content
   * @param {string} role - Message role
   * @returns {string} Rendered HTML
   */
  _renderContent(content, role) {
    if (!content) return '';

    if (role === 'assistant') {
      // Render markdown for assistant messages
      return this.markdownRenderer.render(content, {
        sanitize: true,
        profile: 'markdown'
      });
    } else {
      // Escape HTML for user/system messages
      return this.securitySanitizer.escapeHTML(content);
    }
  }

  /**
   * Format timestamp
   * @private
   * @param {string|number} timestamp - ISO timestamp or epoch ms
   * @returns {string} Formatted time
   */
  _formatTimestamp(timestamp) {
    try {
      if (!timestamp) return new Date().toLocaleTimeString();

      const date = typeof timestamp === 'string' && timestamp.includes('T')
        ? new Date(timestamp)
        : new Date();

      return date.toLocaleTimeString();
    } catch (error) {
      console.warn('[MessageView] Timestamp formatting failed:', error);
      return new Date().toLocaleTimeString();
    }
  }

  /**
   * Prune old messages to maintain performance
   * @private
   */
  _pruneMessages() {
    if (!this.contentElement) return;

    const entries = this.contentElement.querySelectorAll('.chat-entry');
    const excess = entries.length - this.maxMessages;

    if (excess > 0) {
      console.log(`[MessageView] Pruning ${excess} old messages`);

      for (let i = 0; i < excess; i++) {
        const entry = entries[i];
        const messageId = entry.dataset.messageId;

        if (messageId) {
          this.messageElements.delete(messageId);
        }

        if (entry.parentNode) {
          entry.parentNode.removeChild(entry);
        }
      }
    }
  }

  /**
   * Generate temporary message ID
   * @private
   * @returns {string}
   */
  _generateTempId() {
    return `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get message count
   * @returns {number}
   */
  getMessageCount() {
    return this.messageElements.size;
  }

  /**
   * Get message element by ID
   * @param {string} messageId
   * @returns {HTMLElement|null}
   */
  getMessageElement(messageId) {
    return this.messageElements.get(messageId) || null;
  }

  /**
   * Set auto-scroll behavior
   * @param {boolean} enabled
   */
  setAutoScroll(enabled) {
    this.autoScroll = enabled;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    console.log('[MessageView] Disposing...');

    // Cancel pending RAF
    if (this._scrollRaf) {
      cancelAnimationFrame(this._scrollRaf);
      this._scrollRaf = null;
    }

    // Clear DOM
    this.clear();

    // Dispose dependencies
    if (this.markdownRenderer) {
      this.markdownRenderer.dispose();
    }
    if (this.securitySanitizer) {
      this.securitySanitizer.dispose();
    }

    // Clear references
    this.contentElement = null;
    this.markdownRenderer = null;
    this.securitySanitizer = null;
    this.eventBus = null;

    console.log('[MessageView] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageView;
}

if (typeof window !== 'undefined') {
  window.MessageView = MessageView;
  console.log('📦 MessageView loaded');
}

