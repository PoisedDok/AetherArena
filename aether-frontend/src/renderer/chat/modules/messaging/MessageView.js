'use strict';

/**
 * @.architecture
 * 
 * Incoming: StreamHandler.updateMessage(), MessageManager.renderMessage() (method calls with message objects), scroll events --- {message_types.user_message | message_types.assistant_message, javascript_object}
 * Processing: Render markdown for assistant (via MarkdownRenderer), escape HTML for user (via SecuritySanitizer), create DOM elements with chat-entry class, append to container, update existing DOM elements during streaming, prune old messages (max 500), smart auto-scroll with user scroll detection, show/hide scroll-to-bottom button --- {8 jobs: JOB_APPEND_TO_CONTAINER, JOB_CREATE_DOM_ELEMENT, JOB_EMIT_EVENT, JOB_ESCAPE_HTML, JOB_GET_STATE, JOB_RENDER_MARKDOWN, JOB_SCROLL_TO_BOTTOM, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: DOM container (.aether-chat-content), scroll-to-bottom button --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * @.security innerHTML audit: SAFE
 * User message content: escaped via securitySanitizer.escapeHTML() before innerHTML.
 * Assistant content: rendered via MarkdownRenderer with sanitize:true (DOMPurify-backed).
 * Filenames: escaped via securitySanitizer.escapeHTML() and _sanitizeFilenameForDisplay().
 * Static HTML: message structure templates, loading spinner, empty state, typing indicator.
 * 
 * @module renderer/chat/modules/messaging/MessageView
 */

const { createRendererLogger } = require('../../../shared/utils/logger');
const MarkdownRenderer = require('../../../shared/messaging/MarkdownRenderer');
const SecuritySanitizer = require('../../../shared/security/SecuritySanitizer');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const Toast = require('../../../shared/components/Toast');

class MessageView {
  constructor(options = {}) {
    // Dependencies
    this.markdownRenderer = options.markdownRenderer || new MarkdownRenderer();
    this.securitySanitizer = options.securitySanitizer || new SecuritySanitizer();
    this.eventBus = options.eventBus || null;
    this.messageState = options.messageState || null;  // CRITICAL FIX: For chat ID access
    this.aether = options.aether || getAether();

    // DOM references
    this.contentElement = null;
    this.scrollButtonElement = null;

    // Configuration
    this.maxMessages = options.maxMessages || 500;
    this._scrollThreshold = 100; // px from bottom to consider "at bottom"

    // State
    this.messageElements = new Map(); // messageId -> DOM element
    this._hasUntrackedMessages = false;
    this._typingIndicatorElement = null; // Typing indicator DOM reference
    
    // Lifecycle
    this._isDisposed = false;
    this._eventBusCleanups = [];       // MV-2: EventBus unsubscribe functions
    this._domListeners = [];           // Tracking DOM listeners
    this._typingFallbackTimer = null;  // MV-3: hideTypingIndicator safety setTimeout
    
    // Logging
    this.log = createRendererLogger('MessageView');

    // Throttled logging for streaming updates
    this._updateLogThrottle = {
      lastLog: 0,
      interval: 1000, // Log at most once per second
      updateCount: 0,
      currentMessageId: null
    };

    // Bind methods
    this._handleScrollToBottomClick = this._handleScrollToBottomClick.bind(this);

    this.log.debug('constructed');
  }

  /**
   * Initialize with content element
   * @param {HTMLElement} contentElement - Content container element
   */
  init(contentElement) {
    if (this._isDisposed) return;
    if (!contentElement) {
      throw new Error('[MessageView] Content element required');
    }

    this.contentElement = contentElement;
    
    // Set up event listeners for cross-component communication
    this._setupEventListeners();
    
    // Set up local DOM events
    this._handleLinkClick = this._handleLinkClick.bind(this);
    this._trackListener(this.contentElement, 'click', this._handleLinkClick);
    
    // Create scroll-to-bottom button
    this._createScrollButton();

    this.log.debug('initialized');
  }
  
  /**
   * Set up EventBus listeners
   * @private
   */
  _setupEventListeners() {
    if (this.eventBus) {
      // MV-2: Store cleanup functions returned by eventBus.on()
      const cleanupOpenFile = this.eventBus.on('artifacts:open-file', (data) => {
        this._handleOpenFileFromEvent(data);
      });
      if (typeof cleanupOpenFile === 'function') this._eventBusCleanups.push(cleanupOpenFile);

      const cleanupAtBottom = this.eventBus.on('scroll:at-bottom', () => {
        this._hideScrollButton();
      });
      if (typeof cleanupAtBottom === 'function') this._eventBusCleanups.push(cleanupAtBottom);

      const cleanupScrolledUp = this.eventBus.on('scroll:scrolled-up', () => {
        this._showScrollButton();
      });
      if (typeof cleanupScrolledUp === 'function') this._eventBusCleanups.push(cleanupScrolledUp);
    }
  }
  
  /**
   * Track DOM listener for cleanup
   * @private
   */
  _trackListener(element, event, handler, options) {
    element.addEventListener(event, handler, options);
    this._domListeners.push({ element, event, handler, options });
  }

  /**
   * Remove DOM event listeners for elements within a node
   * @private
   */
  _clearListenersForNode(rootNode) {
    if (!rootNode) return;
    const retained = [];
    for (let i = 0; i < this._domListeners.length; i++) {
      const entry = this._domListeners[i];
      const { element, event, handler, options } = entry;
      
      // Target elements inside the rootNode
      if (element === rootNode || rootNode.contains(element)) {
        try {
          element.removeEventListener(event, handler, options);
        } catch (e) {
          this.log.debug('Failed to remove DOM listener', { error: e?.message || String(e) });
        }
      } else {
        retained.push(entry);
      }
    }
    this._domListeners = retained;
  }

  /**
   * Handle scroll-to-bottom button click
   * @private
   */
  _handleScrollToBottomClick() {
    if (this.eventBus) {
      this.eventBus.emit('scroll:request-bottom', { behavior: 'smooth', force: true });
    }
    this._hideScrollButton();
    this.log.debug('scroll-to-bottom button clicked');
  }

  /**
   * Handle global clicks on links to prevent Electron navigation
   * @private
   */
  _handleLinkClick(e) {
    const link = e.target.closest('a');
    if (!link || !link.href) return;

    // Check if it's an HTTP/S link or a local file link
    const isHttp = link.href.startsWith('http://') || link.href.startsWith('https://');
    const isMailto = link.href.startsWith('mailto:');
    
    // For local file links, prevent Electron from navigating the main frame
    // and use the aether bridge to open it natively via the OS.
    if (!isHttp && !isMailto) {
      e.preventDefault();
      try {
        if (this.aether && this.aether.artifacts && this.aether.artifacts.openFile) {
          // Decode URI component to handle spaces (%20) in local file paths
          const cleanPath = decodeURIComponent(link.href.replace(/^file:\/\//i, ''));
          this.aether.artifacts.openFile(cleanPath);
        } else {
          this.log.warn('Aether bridge openFile not available for local link', { href: link.href });
        }
      } catch (err) {
        this.log.error('Failed to open local file link from chat', { href: link.href, error: err });
      }
    }
  }

  /**
   * Create scroll-to-bottom button
   * @private
   */
  _createScrollButton() {
    if (!this.contentElement || !this.contentElement.parentElement) return;
    
    const button = document.createElement('button');
    button.className = 'chat-scroll-to-bottom';
    button.innerHTML = '↓';
    button.title = 'Scroll to bottom';
    button.style.display = 'none'; // Hidden by default
    button.setAttribute('aria-label', 'Scroll to bottom');
    
    this._trackListener(button, 'click', this._handleScrollToBottomClick);
    
    // Insert before input wrapper (after content area)
    const parent = this.contentElement.parentElement;
    const inputWrapper = parent.querySelector('.aether-chat-input-wrapper');
    if (inputWrapper) {
      parent.insertBefore(button, inputWrapper);
    } else {
      parent.appendChild(button);
    }
    
    this.scrollButtonElement = button;
    this.log.debug('scroll-to-bottom button created');
  }
  
  /**
   * Show scroll-to-bottom button
   * @private
   */
  _showScrollButton() {
    if (this.scrollButtonElement) {
      this.scrollButtonElement.style.display = 'flex';
    }
  }
  
  /**
   * Hide scroll-to-bottom button
   * @private
   */
  _hideScrollButton() {
    if (this.scrollButtonElement) {
      this.scrollButtonElement.style.display = 'none';
    }
  }
  
  /**
   * Handle file open event from other components (e.g., ChatFilesModal)
   * @private
   */
  async _handleOpenFileFromEvent(data) {
    const { artifactId, filename, content, type, metadata } = data;
    this.log.info('Opening file from event', { artifactId, filename });
    
    try {
      // Initialize FileViewerModal if needed
      if (!this.fileViewerModal) {
        const FileViewerModal = require('../../modals/FileViewerModal');
        this.fileViewerModal = new FileViewerModal({ 
          eventBus: this.eventBus,
          container: document.body
        });
      }
      
      // Prepare file data
      const fileData = {
        filename: filename || 'Untitled',
        content: content,
        language: metadata?.language,
        metadata: {
          size: content?.length,
          type: type,
          ...metadata
        }
      };
      
      // Open modal
      await this.fileViewerModal.open(fileData);
      if (this._isDisposed) return;
    } catch (error) {
      this.log.error('Failed to open file from event', { error, artifactId });
      Toast.error('Failed to open file. Please try again.');
    }
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
    if (this._isDisposed) return null;
    if (!this.contentElement) {
      this.log.warn('renderMessage called before initialization');
      return null;
    }

    if (!message) {
      this.log.warn('renderMessage received invalid message reference');
      return null;
    }

    if (!message.content && message.role !== 'assistant') {
      this.log.warn('renderMessage rejected empty non-assistant message', { messageId: message?.id, role: message?.role });
      return null;
    }

    // ARCHITECTURAL FIX: Prevent duplicate message rendering
    // During chat switch, messages might be rendered multiple times
    // (initial load + session map restoration). Check if already exists.
    if (message.id && this.messageElements.has(message.id)) {
      this.log.debug('message already rendered - skipping duplicate', { messageId: message.id });
      return this.messageElements.get(message.id);
    }

    // Remove the "New Conversation" empty state placeholder if still present.
    // It was shown when the chat had zero messages; the first real message replaces it.
    this._removeEmptyState();

    const entry = document.createElement('div');
    entry.className = 'chat-entry message'; // Add 'message' class for trail anchor selector
    if (message.metadata?.hidden) {
      entry.classList.add('hidden');
      entry.style.display = 'none'; // Robustness: ensure strictly hidden regardless of CSS load state
    }
    if (!message.id) {
      this._hasUntrackedMessages = true;
    }
    entry.dataset.messageId = message.id || this._generateTempId();
    entry.dataset.role = message.role || 'system';
    
    // CRITICAL: Set backend_id and correlation_id for trail positioning
    // Trails use this to insert after the correct user message
    if (message.backend_id) {
      entry.dataset.backendId = message.backend_id;
    }
    if (message.correlation_id) {
      entry.dataset.correlationId = message.correlation_id;
    }
    
    // Set sequence for timeline ordering
    if (message.sequence_in_chat !== undefined) {
      entry.dataset.sequence = message.sequence_in_chat;
    }
    
    // Add error type marker for styling
    if (message.type === 'error' || message.error_category) {
      entry.classList.add('chat-entry-error');
      if (message.error_category) {
        entry.dataset.errorCategory = message.error_category;
      }
    }

    const timestamp = this._formatTimestamp(message.timestamp);
    const contentHTML = this._renderContent(message.content, message.role, message.type);
    const roleIndicator = this._getRoleIndicator(message.role);
    const safeRole = ['user', 'assistant', 'system'].includes(message.role) ? message.role : 'system';
    
    // Check if this message will be placed after a trail container
    // If so, skip the role indicator since the trail already has one
    let showRoleIndicator = true;
    if (message.role === 'assistant' && message.backend_id) {
      // This assistant message might have a trail before it
      // We'll check after insertion, but for now include the indicator
      // The trail insertion logic will handle this
    }

    entry.innerHTML = `
      <div class="chat-role-indicator">${roleIndicator}</div>
      <div class="chat-message-content">
        <div class="chat-timestamp">${timestamp}</div>
        <div class="chat-text ${safeRole} ${message.type === 'error' ? 'error-content' : ''}">${contentHTML}</div>
      </div>
    `;

    this.contentElement.appendChild(entry);

    if (message.id) {
      this.messageElements.set(message.id, entry);
    }

    this._pruneMessages();

    this.log.debug('rendered chat message', {
      messageId: message.id,
      role: message.role
    });
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
    if (this._isDisposed) return null;
    if (!this.contentElement) {
      this.log.warn('renderMessageWithAttachments called before initialization');
      return null;
    }

    // Remove the "New Conversation" empty state placeholder if still present.
    this._removeEmptyState();

    // Create message entry
    const entry = document.createElement('div');
    entry.className = 'chat-entry message'; // Add 'message' class for trail anchor selector
    if (message.metadata?.hidden) {
      entry.classList.add('hidden');
      entry.style.display = 'none'; // Robustness: ensure strictly hidden regardless of CSS load state
    }
    if (!message.id) {
      this._hasUntrackedMessages = true;
    }
    entry.dataset.messageId = message.id || this._generateTempId();
    entry.dataset.role = 'user'; // Attachments are always from user

    // Format timestamp
    const timestamp = this._formatTimestamp(message.timestamp);
    const roleIndicator = this._getRoleIndicator('user');

    // Build preview HTML
    let previewHTML = '';

    // Image preview
    if (attachments.imageBase64) {
      let safeUri = '';
      if (typeof attachments.imageBase64 === 'string') {
        const cleanUri = attachments.imageBase64.trim();
        if (cleanUri.startsWith('data:image/') || cleanUri.startsWith('http://') || cleanUri.startsWith('https://')) {
          safeUri = this.securitySanitizer.escapeHTML(cleanUri);
        }
      }
      if (safeUri) {
        previewHTML += `
          <div class="attachment-preview">
            <img 
              src="${safeUri}" 
              alt="Attached image" 
              class="attached-image"
            />
          </div>
        `;
      }
    }

    // File list
    if (attachments.files && attachments.files.length > 0) {
      const fileCount = attachments.files.length;
      previewHTML += `
        <div class="attachment-files-container">
          <div class="attachment-summary">${fileCount} ${fileCount === 1 ? 'file' : 'files'} attached</div>
          ${attachments.files.map(file => {
            const fileName = this.securitySanitizer.escapeHTML(
              this._sanitizeFilenameForDisplay(file.name || 'Untitled')
            );
            const fileSize = file.size ? this._formatFileSize(file.size) : '';
            const isJSON = file.name && file.name.toLowerCase().endsWith('.json');  // CRITICAL FIX: Guard against undefined
            const icon = isJSON ? 'DOC' : 'FILE';
            
            return `
              <div class="file-attachment-item" data-artifact-id="${this.securitySanitizer.escapeHTML(String(file.artifactId || ''))}" title="Click to open">
                <div class="file-attachment-icon">${icon}</div>
                <div class="file-attachment-info">
                  <div class="file-attachment-name">${fileName}</div>
                  ${fileSize ? `<div class="file-attachment-size">${fileSize}</div>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // Message content
    const contentHTML = message.content
      ? `<div class="chat-text user">${this.securitySanitizer.escapeHTML(message.content)}</div>`
      : '';

    // Build complete HTML
    entry.innerHTML = `
      <div class="chat-role-indicator">${roleIndicator}</div>
      <div class="chat-message-content">
        <div class="chat-timestamp">${timestamp}</div>
        ${contentHTML}
        ${previewHTML}
      </div>
    `;

    // Append to content
    this.contentElement.appendChild(entry);

    // Add click handlers for image attachments
    if (attachments.imageBase64) {
      const imageEl = entry.querySelector('.attached-image');
      
      if (imageEl) {
        imageEl.style.cursor = 'pointer';
        this._trackListener(imageEl, 'click', async () => {
          
          // For persisted images, we need to find the artifact
          const chatId = this.messageState?.currentChatId;  // CRITICAL FIX: Use messageState instead of chatController
          
          
          if (chatId && this.aether?.storage) {
            try {
              const artifacts = await this.aether.storage.loadArtifacts(chatId);
              if (this._isDisposed) return;
              
              
              const imageArtifact = artifacts.find(a => 
                a.message_id === message.id && this._isImageFile(a.title || a.filename)  // CRITICAL FIX: Use title
              );
              
              
              if (imageArtifact) {
                await this._handleFileAttachmentClickById(imageArtifact.id);
                if (this._isDisposed) return;
              } else {
                Toast.error('Image not found. It may have been deleted.');
              }
            } catch (error) {
              this.log.error('Failed to open image attachment', { error });
              Toast.error('Failed to open image attachment. Please try again.');
            }
          } else {
          }
        });
      }
    }

    // Add click handlers for file attachments
    if (attachments.files && attachments.files.length > 0) {
      const fileItems = entry.querySelectorAll('.file-attachment-item');
      fileItems.forEach((item, index) => {
        this._trackListener(item, 'click', async () => {
          const file = attachments.files[index];
          const artifactId = item.dataset.artifactId;
          
          // If we have the artifact ID, load directly
          if (artifactId) {
            await this._handleFileAttachmentClickById(artifactId);
          } else {
            // Fallback to search by filename
            await this._handleFileAttachmentClick(file, message);
          }
        });
        
        // Add hover effect
        item.style.cursor = 'pointer';
        this._trackListener(item, 'mouseenter', () => {
          item.style.background = 'var(--color-surface-hover)';
        });
        this._trackListener(item, 'mouseleave', () => {
          item.style.background = 'var(--color-surface-base)';
        });
      });
    }

    // Track element
    if (message.id) {
      this.messageElements.set(message.id, entry);
    }

    // Prune
    this._pruneMessages();

    this.log.debug('rendered message with attachments', {
      messageId: message.id,
      attachmentCount: attachments?.files?.length || 0,
      hasImage: Boolean(attachments?.imageBase64)
    });
    return entry;
  }

  /**
   * Handle file attachment click by artifact ID (faster, direct lookup)
   * @private
   */
  async _handleFileAttachmentClickById(artifactId) {
    try {
      
      if (this.aether?.storage) {
        const artifact = await this.aether.storage.getArtifact(artifactId);
        if (this._isDisposed) return;
        
        
        if (artifact) {
          // Open in file viewer modal
          if (!this.fileViewerModal) {
            const FileViewerModal = require('../../modals/FileViewerModal');
            this.fileViewerModal = new FileViewerModal({ 
              eventBus: this.eventBus,
              container: document.body
            });
            
          }
          
          const fileData = {
            filename: artifact.title || artifact.filename || 'Untitled',  // CRITICAL FIX: Use title
            content: artifact.content,
            language: artifact.language,
            metadata: {
              size: artifact.content?.length,
              type: artifact.type,
              ...artifact.metadata
            }
          };
          
          
          this.fileViewerModal.open(fileData);
          
          
          this.log.info('Opened file in viewer modal', { artifactId, filename: fileData.filename });
        } else {
          this.log.warn('Artifact not found by ID', { artifactId });
          Toast.error('File not found. It may have been deleted.');
        }
      }
    } catch (error) {
      this.log.error('Failed to open file attachment by ID', { error, artifactId });
      Toast.error('Failed to open file attachment. Please try again.');
    }
  }
  
  /**
   * Handle file attachment click - open in file viewer modal (fallback to filename search)
   * @private
   */
  async _handleFileAttachmentClick(file, message) {
    try {
      this.log.debug('File attachment clicked', { fileName: file.name, messageId: message.id });
      
      // Get chat ID
      const chatId = this.messageState?.currentChatId;  // CRITICAL FIX: Use messageState instead of chatController
      if (!chatId) {
        this.log.warn('No active chat ID');
        Toast.warning('Cannot open file attachment without an active chat.');
        return;
      }
      
      // Load artifacts for this chat and find matching file
      if (this.aether?.storage) {
        const artifacts = await this.aether.storage.loadArtifacts(chatId);
        if (this._isDisposed) return;
        const matchingArtifact = artifacts.find(a => 
          a.title === file.name ||  // CRITICAL FIX: Backend uses 'title' not 'filename'
          a.filename === file.name || 
          a.metadata?.original_name === file.name
        );
        
        if (matchingArtifact) {
          // Open in file viewer modal
          if (!this.fileViewerModal) {
            const FileViewerModal = require('../../modals/FileViewerModal');
            this.fileViewerModal = new FileViewerModal({ 
              eventBus: this.eventBus,
              container: document.body  // CRITICAL FIX: BaseModal needs a container
            });
          }
          
          this.fileViewerModal.open({
            filename: matchingArtifact.filename,
            content: matchingArtifact.content,
            language: matchingArtifact.language,
            metadata: {
              size: matchingArtifact.content?.length,
              type: matchingArtifact.type,
              ...matchingArtifact.metadata
            }
          });
          
          this.log.info('Opening file in viewer modal', { 
            fileName: file.name,
            artifactId: matchingArtifact.id 
          });
        } else {
          this.log.warn('Artifact not found for file', { fileName: file.name });
          Toast.error('File not found. It may have been deleted.');
        }
      } else {
        Toast.error('Storage service is currently unavailable.');
      }
    } catch (error) {
      this.log.error('Failed to open file attachment', { error, fileName: file.name });
      Toast.error('Failed to open file attachment. Please try again.');
    }
  }
  
  /**
   * Check if file is an image based on extension
   * @private
   */
  _isImageFile(filename) {
    if (!filename) return false;
    const ext = filename.toLowerCase().split('.').pop();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
  }

  /**
   * Format file size for display
   * @private
   */
  _formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Sanitize a filename for safe UI display (avoid leaking HTML/event-handler tokens into DOM text/attrs).
   * @private
   */
  _sanitizeFilenameForDisplay(name) {
    if (typeof name !== 'string') return 'Untitled';
    const trimmed = name.trim();
    if (!trimmed) return 'Untitled';

    // Remove control chars + common injection tokens that we never want to show verbatim.
    let s = trimmed.replace(/[\u0000-\u001f\u007f]/g, '');
    s = s.replace(/on\w+\s*=/gi, ''); // e.g. onerror=, onclick=
    s = s.replace(/javascript:/gi, '');
    s = s.replace(/data:/gi, '');

    // Keep filenames reasonably bounded (prevents UI blowups).
    if (s.length > 255) s = s.slice(0, 255);
    return s || 'Untitled';
  }

  /**
   * Update DOM nodes incrementally to prevent full innerHTML layout jank during streaming
   * @param {HTMLElement} parent - Parent node to update
   * @param {string} newHtml - New HTML content
   * @private
   */
  _updateDOMIncrementally(parent, newHtml) {
    if (parent.innerHTML === newHtml) return;
    
    // Leverage morphdom for robust, non-destructive DOM diffing (Phase 2 architectural standard)
    let morphdom = null;
    try {
      morphdom = require('morphdom');
    } catch (e) {
      // Fallback if morphdom is not installed
    }

    if (morphdom) {
      const tempNode = document.createElement(parent.tagName);
      tempNode.className = parent.className;
      // Copy over data attributes that might be on the parent
      for (const attr of parent.attributes) {
        if (attr.name !== 'class') {
          tempNode.setAttribute(attr.name, attr.value);
        }
      }
      tempNode.innerHTML = newHtml;

      morphdom(parent, tempNode, {
        onBeforeElUpdated: function(fromEl, toEl) {
          // Preserve highlighted code blocks
          if (fromEl.tagName === 'CODE' && fromEl.dataset && fromEl.dataset.highlighted) {
             if (toEl.dataset) {
               toEl.dataset.highlighted = fromEl.dataset.highlighted;
             }
          }
          return true;
        }
      });
      return;
    }
    
    const template = document.createElement('template');
    template.innerHTML = newHtml;
    const newNodes = Array.from(template.content.childNodes);
    const oldNodes = Array.from(parent.childNodes);
    
    // Fast path: Streaming typically modifies the last node and appends new ones.
    // If all previous nodes are identical, we can just update the last node and append the rest.
    if (oldNodes.length > 0 && newNodes.length >= oldNodes.length) {
      let isAppendOnly = true;
      
      // Check if all nodes EXCEPT the last one are identical
      for (let i = 0; i < oldNodes.length - 1; i++) {
        const oldNode = oldNodes[i];
        const newNode = newNodes[i];
        
        if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeName !== newNode.nodeName) {
          isAppendOnly = false;
          break;
        }
        
        if (oldNode.nodeType === Node.ELEMENT_NODE && oldNode.outerHTML !== newNode.outerHTML) {
          isAppendOnly = false;
          break;
        } else if (oldNode.nodeType === Node.TEXT_NODE && oldNode.textContent !== newNode.textContent) {
          isAppendOnly = false;
          break;
        }
      }
      
      if (isAppendOnly) {
        const lastIdx = oldNodes.length - 1;
        const oldLast = oldNodes[lastIdx];
        const newLast = newNodes[lastIdx];
        
        if (oldLast.nodeType === newLast.nodeType && oldLast.nodeName === newLast.nodeName) {
          if (oldLast.nodeType === Node.TEXT_NODE) {
            if (oldLast.textContent !== newLast.textContent) {
              oldLast.textContent = newLast.textContent;
            }
          } else {
            // Update attributes if changed
            if (oldLast.outerHTML !== newLast.outerHTML) {
              const newAttrs = newLast.attributes;
              for (let j = oldLast.attributes.length - 1; j >= 0; j--) {
                const attrName = oldLast.attributes[j].name;
                if (!newLast.hasAttribute(attrName)) {
                  oldLast.removeAttribute(attrName);
                }
              }
              for (let j = 0; j < newAttrs.length; j++) {
                if (oldLast.getAttribute(newAttrs[j].name) !== newAttrs[j].value) {
                  oldLast.setAttribute(newAttrs[j].name, newAttrs[j].value);
                }
              }
              // Only diff the innerHTML of the last element
              this._updateDOMIncrementally(oldLast, newLast.innerHTML);
            }
          }
          
          // Append any brand new nodes
          for (let i = oldNodes.length; i < newNodes.length; i++) {
            parent.appendChild(newNodes[i].cloneNode(true));
          }
          return;
        }
      }
    }
    
    // Fallback: full replacement if structure changed drastically
    this._clearListenersForNode(parent);
    while (parent.firstChild) {
      parent.removeChild(parent.firstChild);
    }
    for (const node of newNodes) {
      parent.appendChild(node.cloneNode(true));
    }
  }

  /**
   * Update an existing message
   * @param {string} messageId - Message ID
   * @param {string} content - New content
   */
  updateMessage(messageId, content) {
    if (this._isDisposed) return false;
    if (!messageId) {
      this.log.debug('updateMessage rejected missing messageId');
      return false;
    }

    let entry = this.messageElements.get(messageId);
    if (!entry) {
      // Late-arriving update: create a placeholder message so streaming doesn't lose content.
      const created = this.renderMessage({
        id: messageId,
        role: 'assistant',
        content: content || '',
        timestamp: Date.now(),
      });
      entry = created || null;
    }
    if (!entry) {
      this.log.debug('updateMessage skipped missing element', { messageId });
      return false;
    }

    const role = entry.dataset.role || 'system';
    const type = entry.classList.contains('chat-entry-error') ? 'error' : null;
    const textElement = entry.querySelector('.chat-text');

    if (textElement) {
      // DEBUG: Log incoming content before rendering
      const contentLen = content ? content.length : 0;
      this.log.trace('rendering diagnostics', {
        stage: 'input',
        role,
        type,
        length: contentLen,
        preview: content?.substring(0, 200)
      });
      
      const contentHTML = this._renderContent(content, role, type);
      
      // Use incremental DOM update instead of full innerHTML wipe to prevent layout thrashing
      this._updateDOMIncrementally(textElement, contentHTML);
      
      // Find the visualizer inside the newly updated DOM if it exists and resume it
      const visualizer = textElement.querySelector('.agent-visualizer');
      if (visualizer && typeof visualizer.resume === 'function') {
        visualizer.resume();
      }
      
      // Throttled logging for streaming updates
      const now = Date.now();
      const throttle = this._updateLogThrottle;
      
      // Track update count
      if (throttle.currentMessageId !== messageId) {
        throttle.currentMessageId = messageId;
        throttle.updateCount = 0;
      }
      throttle.updateCount++;
      
      // Log only if enough time has passed
      if (now - throttle.lastLog >= throttle.interval) {
        this.log.trace('streaming update throttled log', {
          messageId,
          updates: throttle.updateCount,
          length: contentLen
        });
        throttle.lastLog = now;
        throttle.updateCount = 0;
      }
      
      return true;
    }

    return false;
  }

  /**
   * Update message status (e.g. error, pending)
   * @param {string} messageId - Message ID or Correlation ID
   * @param {string} status - New status ('error', 'pending', 'sent')
   * @param {string} [errorMsg] - Error message if status is 'error'
   */
  updateMessageStatus(messageId, status, errorMsg) {
    if (this._isDisposed) return false;
    if (!messageId) return false;

    // Support lookup by messageId or dataset.correlationId
    let entry = this.messageElements.get(messageId);
    if (!entry) {
      entry = Array.from(this.messageElements.values()).find(
        el => el.dataset.correlationId === messageId || el.dataset.messageId === messageId
      );
    }
    if (!entry) return false;

    if (status === 'error') {
      entry.classList.add('chat-entry-error');
      entry.classList.remove('chat-entry-pending');
      
      const textElement = entry.querySelector('.chat-text');
      if (textElement) {
        let errorContainer = entry.querySelector('.message-error-container');
        if (!errorContainer) {
          errorContainer = document.createElement('div');
          errorContainer.className = 'message-error-container';
          errorContainer.style.marginTop = '8px';
          errorContainer.style.padding = '8px 12px';
          errorContainer.style.background = 'var(--color-error-subtle, rgba(255, 69, 58, 0.1))';
          errorContainer.style.borderLeft = '3px solid var(--color-error, #ff453a)';
          errorContainer.style.borderRadius = '4px';
          errorContainer.style.display = 'flex';
          errorContainer.style.alignItems = 'center';
          errorContainer.style.justifyContent = 'space-between';
          textElement.appendChild(errorContainer);
        }
        
        errorContainer.innerHTML = `
          <div class="message-error-text" style="color: var(--color-error, #ff453a); font-size: 13px;">
            <span class="error-icon" style="margin-right: 6px;">⚠️</span> Failed to send: ${this.securitySanitizer.escapeHTML(errorMsg || 'Unknown error')}
          </div>
          <button class="retry-message-btn" data-message-id="${messageId}" style="background: var(--color-surface-hover, rgba(255,255,255,0.1)); border: 1px solid var(--color-border); color: var(--color-text); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: background 0.2s;">Retry</button>
        `;
        
        const retryBtn = errorContainer.querySelector('.retry-message-btn');
        if (retryBtn) {
          this._trackListener(retryBtn, 'click', () => {
            if (this.eventBus) {
              this.log.info('Retry requested', { messageId });
              this.eventBus.emit('chat:message-retry-requested', { messageId });
              
              // Optimistically set back to pending
              this.updateMessageStatus(messageId, 'pending');
            }
          });
          
          this._trackListener(retryBtn, 'mouseenter', () => {
            retryBtn.style.background = 'var(--color-surface-active, rgba(255,255,255,0.2))';
          });
          this._trackListener(retryBtn, 'mouseleave', () => {
            retryBtn.style.background = 'var(--color-surface-hover, rgba(255,255,255,0.1))';
          });
        }
      }
    } else if (status === 'pending') {
      entry.classList.add('chat-entry-pending');
      entry.classList.remove('chat-entry-error');
      entry.style.opacity = '0.7';
      const errorContainer = entry.querySelector('.message-error-container');
      if (errorContainer) {
        errorContainer.remove();
      }
    } else if (status === 'sent') {
      entry.classList.remove('chat-entry-pending');
      entry.classList.remove('chat-entry-error');
      entry.style.opacity = '1';
      const errorContainer = entry.querySelector('.message-error-container');
      if (errorContainer) {
        errorContainer.remove();
      }
    }
    return true;
  }

  /**
   * Remove a message
   * @param {string} messageId - Message ID
   */
  removeMessage(messageId) {
    if (this._isDisposed) return false;
    const entry = this.messageElements.get(messageId);
    if (entry && entry.parentNode) {
      this._clearListenersForNode(entry);
      entry.parentNode.removeChild(entry);
      this.messageElements.delete(messageId);
      this.log.debug('removed message element', { messageId });
      return true;
    }
    return false;
  }

  /**
   * Remove a message sequence (user message and subsequent responses/trails)
   * @param {string} messageId - User message ID
   */
  removeMessageSequence(messageId) {
    if (this._isDisposed) return false;
    
    if (!this.contentElement) return false;
    
    const entries = Array.from(this.contentElement.querySelectorAll('.chat-entry'));
    let userEntryIndex = -1;
    let removedCount = 0;

    // Find the user message entry
    entries.forEach((entry, index) => {
      if (entry.dataset.messageId === messageId) {
        userEntryIndex = index;
      }
    });

    if (userEntryIndex !== -1) {
      // Remove the user message
      const userEntry = entries[userEntryIndex];
      this._clearListenersForNode(userEntry);
      userEntry.remove();
      this.messageElements.delete(messageId);
      removedCount++;

      // Find the assistant message index
      let assistantIndex = -1;
      for (let i = userEntryIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.dataset.role === 'assistant') {
          assistantIndex = i;
          break;
        } else if (entry.dataset.role === 'user') {
          // Hit the next user message before an assistant message
          break;
        }
      }

      // Remove ALL entries from user+1 to assistant (inclusive)
      // This removes trail containers and the assistant message
      if (assistantIndex !== -1) {
        for (let i = userEntryIndex + 1; i <= assistantIndex; i++) {
          const entry = entries[i];
          const entryId = entry.dataset.messageId;
          if (entryId) {
            this.messageElements.delete(entryId);
          }
          this._clearListenersForNode(entry);
          entry.remove();
          removedCount++;
        }
      }
      
      this.log.debug('removed message sequence', { messageId, removedCount });
      return true;
    }
    
    return false;
  }

  /**
   * Clear all messages
   */
  clear() {
    if (this._isDisposed) return;
    if (this.contentElement) {
      this._clearListenersForNode(this.contentElement);
      while (this.contentElement.firstChild) {
        this.contentElement.removeChild(this.contentElement.firstChild);
      }
    }
    this.messageElements.clear();
    this._hasUntrackedMessages = false;
    this._typingIndicatorElement = null; // Cleared by wipe
    this.log.debug('cleared all messages');
  }

  /**
   * Show loading state
   */
  showLoadingState() {
    if (this._isDisposed || !this.contentElement) return;
    
    this._typingIndicatorElement = null; // Will be destroyed by wipe
    this._clearListenersForNode(this.contentElement);
    while (this.contentElement.firstChild) {
      this.contentElement.removeChild(this.contentElement.firstChild);
    }
    
    const loader = document.createElement('div');
    loader.className = 'message-loading';
    loader.innerHTML = `
      <div class="loading-spinner"></div>
      <p>Loading messages...</p>
    `;
    this.contentElement.appendChild(loader);
  }

  /**
   * Hide loading state
   */
  hideLoadingState() {
    if (this._isDisposed || !this.contentElement) return;
    
    const loader = this.contentElement.querySelector('.message-loading');
    if (loader) loader.remove();
  }

  /**
   * Render messages asynchronously in batches
   * Prevents UI blocking with large message counts
   * ARCHITECTURAL FIX: Load artifacts for user messages and render with attachments
   */
  async renderMessages(messages) {
    if (this._isDisposed) return;
    
    if (!this.contentElement || !Array.isArray(messages)) {
      this.log.warn('renderMessages called with invalid state');
      return;
    }

    // Get chat ID for artifact loading
    const chatId = this.messageState?.currentChatId;  // CRITICAL FIX: Use messageState instead of chatController
    const initialContentElement = this.contentElement;
    
    let artifactsByMessageId = new Map();
    
    // Load all artifacts for this chat (single API call)
    if (chatId && this.aether?.storage) {
      try {
        const artifacts = await this.aether.storage.loadArtifacts(chatId);
        
        // Race condition prevention: check if state mutated during await
        if (this._isDisposed || this.contentElement !== initialContentElement || this.messageState?.currentChatId !== chatId) {
          return;
        }
        
        
        // Group by message_id
        artifacts.forEach(artifact => {
          if (artifact.message_id) {
            if (!artifactsByMessageId.has(artifact.message_id)) {
              artifactsByMessageId.set(artifact.message_id, []);
            }
            artifactsByMessageId.get(artifact.message_id).push(artifact);
          }
        });
        this.log.debug('Loaded artifacts for message rendering', { 
          artifactCount: artifacts.length,
          messagesWithArtifacts: artifactsByMessageId.size 
        });
      } catch (error) {
        this.log.warn('Failed to load artifacts for message rendering', { error });
      }
    }

    // Batch render to prevent blocking main thread
    const BATCH_SIZE = 10;
    
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      
      // Render batch
      for (const message of batch) {
        // CRITICAL FIX: Strip system instructions from corrupted persisted messages
        const cleanedMessage = this._cleanMessageContent(message);
        
        // Check if this message has artifacts (attachments)
        const messageArtifacts = artifactsByMessageId.get(cleanedMessage.id);
        
        // ARCHITECTURAL FIX: Filter out trail-linked artifacts (code/output execution artifacts)
        // Trail-linked artifacts have node_id and subgroup_id - they belong in trail containers, NOT inline
        // Only render user-uploaded attachments (files, images) inline
        const userAttachments = messageArtifacts ? messageArtifacts.filter(artifact => {
          // Trail-linked artifacts have node_id and subgroup_id from execution
          const isTrailLinked = artifact.node_id || artifact.subgroup_id;
          // Only include non-trail-linked artifacts (user uploads)
          return !isTrailLinked;
        }) : [];
        
        if (cleanedMessage.role === 'user' && userAttachments && userAttachments.length > 0) {
          
          // Render with attachments
          // Separate images from other files for proper rendering
          const images = userAttachments.filter(a => this._isImageFile(a.title || a.filename));
          const otherFiles = userAttachments.filter(a => !this._isImageFile(a.title || a.filename));
          
          
          const attachmentData = {
            // For persisted images, include content as base64 data URL
            imageBase64: images.length > 0 && images[0].content ? 
              `data:image/png;base64,${images[0].content}` : null,
            files: otherFiles.map(a => {
              // CRITICAL FIX: Use 'title' field (backend maps filename -> title in ArtifactResponse)
              let filename = a.title || a.filename || a.name;
              if (!filename && a.artifact_id) {
                // Extract from artifact_id (e.g., "file:1768062582389:f4302lqzs" -> extract original name from metadata)
                const parts = a.artifact_id.split(':');
                if (parts.length > 2) {
                  filename = parts.slice(2).join(':');  // Use hash as fallback
                }
              }
              if (!filename && a.metadata) {
                try {
                  const meta = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata;
                  filename = meta.original_filename || meta.filename || meta.name;
                } catch (e) {
                  this.logger.debug('Failed to parse metadata original_filename', { error: e?.message || String(e) });
                }
              }
              return {
                name: filename || 'Untitled',
                size: a.content?.length || a.size || 0,
                type: a.type,
                artifactId: a.id
              };
            })
          };
          
          
          
          this.renderMessageWithAttachments(cleanedMessage, attachmentData);
        } else {
          // Render without attachments
          this.renderMessage(cleanedMessage);
        }
      }
      
      // Yield to browser for next frame (prevent UI blocking)
      if (i + BATCH_SIZE < messages.length) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (this._isDisposed) return;
      }
    }
    
    this.log.debug('async batch rendering complete', { messageCount: messages.length });
  }
  
  /**
   * Clean corrupted message content (strip system instructions)
   * @private
   */
  _cleanMessageContent(message) {
    if (!message || message.role !== 'user' || !message.content) {
      return message;
    }
    
    // Detect system instructions pattern
    const systemInstructionPattern = /^\[SYSTEM INSTRUCTION:.*?\[SYSTEM INSTRUCTION: End of attached file content.*?\]\s*/s;
    
    if (systemInstructionPattern.test(message.content)) {
      // Strip system instructions
      const cleanedContent = message.content.replace(systemInstructionPattern, '').trim();
      this.log.info('Stripped system instructions from corrupted message', {
        messageId: message.id,
        originalLength: message.content.length,
        cleanedLength: cleanedContent.length
      });
      return {
        ...message,
        content: cleanedContent
      };
    }
    
    return message;
  }

  showEmptyState() {
    if (this._isDisposed || !this.contentElement) {
      return;
    }

    // Time-aware greeting — matches the main window welcome text
    const hour = new Date().getHours();
    let timeGreet;
    if (hour >= 5 && hour < 12) {
      timeGreet = 'Good morning';
    } else if (hour >= 12 && hour < 17) {
      timeGreet = 'Good afternoon';
    } else {
      timeGreet = 'Good evening';
    }

    const emptyState = document.createElement('div');
    emptyState.className = 'chat-empty-state';
    
    emptyState.innerHTML = `
      <div class="chat-empty-icon">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" opacity="0.7">
          <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z"/>
        </svg>
      </div>
      <div class="chat-empty-greeting">${this.securitySanitizer.escapeHTML(timeGreet)}</div>
      <div class="chat-empty-title">How can I help?</div>
      <div class="chat-empty-features">
        <span class="chat-empty-feature">Code</span>
        <span class="chat-empty-feature">Research</span>
        <span class="chat-empty-feature">Analysis</span>
        <span class="chat-empty-feature">Create</span>
      </div>
      <div class="chat-empty-hint">Type a message to begin</div>
    `;

    this.contentElement.appendChild(emptyState);
    this.log.trace('showing empty state');
  }

  /**
   * Remove the empty state placeholder from the content container.
   * Called by renderMessage / renderMessageWithAttachments when the
   * first message in a new chat replaces the placeholder.
   * @private
   */
  _removeEmptyState() {
    if (!this.contentElement) return;
    const el = this.contentElement.querySelector('.chat-empty-state');
    if (el) {
      el.remove();
    }
  }

  /**
   * Render content based on role
   * @private
   * @param {string} content - Message content
   * @param {string} role - Message role
   * @returns {string} Rendered HTML
   */
  _renderContent(content, role, type) {
    if (!content) return '';

    // Error messages and system messages render as markdown for formatting
    if (type === 'error' || role === 'system') {
      return this.markdownRenderer.render(content, {
        sanitize: true,
        profile: 'markdown'
      });
    } else if (role === 'assistant') {
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
   * Get simple role indicator
   * @private
   * @param {string} role - Message role
   * @returns {string} Role indicator
   */
  _getRoleIndicator(role) {
    if (role === 'assistant') {
      return 'G';
    } else if (role === 'user') {
      return 'U';
    } else {
      return '•';
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

      // MV-5: Handle both numeric (epoch ms) and ISO string timestamps
      let date;
      if (typeof timestamp === 'number') {
        date = new Date(timestamp);
      } else if (typeof timestamp === 'string') {
        date = new Date(timestamp);
      } else {
        date = new Date();
      }

      // Validate parsed date
      if (isNaN(date.getTime())) {
        this.log.warn('invalid timestamp value', { timestamp });
        return new Date().toLocaleTimeString();
      }

      return date.toLocaleTimeString();
    } catch (error) {
      this.log.warn('timestamp formatting failed', { error: error?.message });
      return new Date().toLocaleTimeString();
    }
  }

  /**
   * Prune old messages to maintain performance
   * @private
   */
  _pruneMessages() {
    if (!this.contentElement) return;

    const excess = this.messageElements.size - this.maxMessages;
    if (excess > 0) {
      this.log.trace('pruned old messages', { excess });

      for (let i = 0; i < excess; i++) {
        const oldestId = this.messageElements.keys().next().value;
        const entry = this.messageElements.get(oldestId);

        if (entry && entry.parentNode) {
          this._clearListenersForNode(entry);
          entry.parentNode.removeChild(entry);
        }
        this.messageElements.delete(oldestId);
      }
    }

    if (this._hasUntrackedMessages) {
      // Fallback: handle any untracked entries (messages without IDs).
      const entries = this.contentElement.querySelectorAll('.chat-entry');
      const domExcess = entries.length - this.maxMessages;
      if (domExcess > 0) {
        this.log.trace('pruned untracked messages', { domExcess });

        for (let i = 0; i < domExcess; i++) {
          const entry = entries[i];
          const messageId = entry.dataset.messageId;

          if (messageId) {
            this.messageElements.delete(messageId);
          }

          if (entry.parentNode) {
            this._clearListenersForNode(entry);
            entry.parentNode.removeChild(entry);
          }
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

  // ============================================================================
  // TYPING INDICATOR (Premium Agent Processing Feedback)
  // ============================================================================

  /**
   * Show typing indicator in chat content area.
   * Indicates that the agent is processing and a response is incoming.
   * Idempotent: calling multiple times will not create duplicates.
   */
  showTypingIndicator() {
    if (this._isDisposed || !this.contentElement) return;

    // Prevent duplicates
    if (this._typingIndicatorElement) return;

    const entry = document.createElement('div');
    entry.className = 'typing-indicator-entry';

    // Role indicator — matches assistant message layout
    const role = document.createElement('div');
    role.className = 'typing-indicator-role';
    role.textContent = 'G';

    // Animated bubble with bouncing dots
    const bubble = document.createElement('div');
    bubble.className = 'typing-indicator-bubble';

    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'typing-dot';
      bubble.appendChild(dot);
    }

    const label = document.createElement('span');
    label.className = 'typing-indicator-label';
    label.textContent = 'Thinking\u2026';
    bubble.appendChild(label);

    entry.appendChild(role);
    entry.appendChild(bubble);

    this.contentElement.appendChild(entry);
    this._typingIndicatorElement = entry;

    // Scroll to bottom so user sees the indicator
    if (this.eventBus) {
      this.eventBus.emit('scroll:request-bottom', { behavior: 'smooth', force: true });
    }

    this.log.debug('typing indicator shown');
  }

  /**
   * Hide typing indicator with a brief fade-out animation.
   * Idempotent: safe to call even if indicator is not visible.
   */
  hideTypingIndicator() {
    if (!this._typingIndicatorElement) return;

    const el = this._typingIndicatorElement;
    this._typingIndicatorElement = null;

    // MV-3: Clear any previous fallback timer before creating a new one
    if (this._typingFallbackTimer !== null) {
      clearTimeout(this._typingFallbackTimer);
      this._typingFallbackTimer = null;
    }

    // Animate out
    el.classList.add('removing');

    // Remove from DOM after animation completes
    const onEnd = () => {
      // Remove from tracker
      this._domListeners = this._domListeners.filter(l => l.handler !== onEnd);
      el.removeEventListener('animationend', onEnd);
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    };
    
    // Track the listener for cleanup
    this._trackListener(el, 'animationend', onEnd);

    // MV-3: Safety fallback tracked for disposal
    this._typingFallbackTimer = setTimeout(() => {
      this._typingFallbackTimer = null;
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }, 300);

    this.log.debug('typing indicator hidden');
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.log.info('disposing');

    // MV-3: Clear typing fallback timer BEFORE hideTypingIndicator (prevents new timer)
    if (this._typingFallbackTimer !== null) {
      clearTimeout(this._typingFallbackTimer);
      this._typingFallbackTimer = null;
    }

    // Remove local event listeners
    if (this.contentElement && this._handleLinkClick) {
      this.contentElement.removeEventListener('click', this._handleLinkClick);
    }

    // Remove typing indicator (will not create new timer since _isDisposed is set)
    // Direct removal instead of animated hide to avoid creating new timers during dispose
    if (this._typingIndicatorElement && this._typingIndicatorElement.parentNode) {
      this._typingIndicatorElement.parentNode.removeChild(this._typingIndicatorElement);
    }
    this._typingIndicatorElement = null;

    // MV-2: Clean up EventBus subscriptions
    for (const cleanup of this._eventBusCleanups) {
      try { cleanup(); } catch (e) { 
        this.log.debug('EventBus cleanup failed or already destroyed', { error: e?.message || String(e) });
      }
    }
    this._eventBusCleanups = [];

    // Remove scroll button
    if (this.scrollButtonElement && this.scrollButtonElement.parentNode) {
      this.scrollButtonElement.removeEventListener('click', this._handleScrollToBottomClick);
      this.scrollButtonElement.parentNode.removeChild(this.scrollButtonElement);
    }

    // Clear DOM
    if (this.contentElement) {
      this._clearListenersForNode(this.contentElement);
      while (this.contentElement.firstChild) {
        this.contentElement.removeChild(this.contentElement.firstChild);
      }
    }
    this.messageElements.clear();
    this._hasUntrackedMessages = false;

    // Remove tracked DOM listeners
    for (const { element, event, handler, options } of this._domListeners) {
      try {
        if (element) element.removeEventListener(event, handler, options);
    } catch (e) {
      this.log.debug('Failed to remove DOM listener', { error: e?.message || String(e) });
    }
    }
    this._domListeners = [];

    // MV-4: Destroy lazily-created FileViewerModal
    if (this.fileViewerModal) {
      try { this.fileViewerModal.destroy(); } catch (e) {
        this.log.debug('FileViewerModal destroy failed or already destroyed', { error: e?.message || String(e) });
      }
      this.fileViewerModal = null;
    }

    // Dispose dependencies
    if (this.markdownRenderer) {
      this.markdownRenderer.dispose();
    }
    if (this.securitySanitizer) {
      this.securitySanitizer.dispose();
    }

    // Clear references
    this.contentElement = null;
    this.scrollButtonElement = null;
    this.markdownRenderer = null;
    this.securitySanitizer = null;
    this.eventBus = null;
    this.messageState = null;
    this.aether = null;

    this.log.debug('disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageView;
}

if (typeof window !== 'undefined') {
  window.MessageView = MessageView;
  createRendererLogger('MessageView').debug('module loaded');
}
