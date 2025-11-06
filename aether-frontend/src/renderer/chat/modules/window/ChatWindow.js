'use strict';

/**
 * @.architecture
 * 
 * Incoming: ChatController (init calls), EventBus (chat:show/hide/toggle), User interactions (new/clear/close buttons) --- {dom_types.dom_event, Event}
 * Processing: Create window DOM (header with controls, content area, input wrapper with textarea+send+file buttons), detect mode (detached=full window vs attached=floating overlay), manage visibility state, delegate style injection to StyleManager --- {5 jobs: JOB_CREATE_DOM_ELEMENT, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_DELEGATE_TO_MODULE}
 * Outgoing: DOM (chat window container), EventBus (window:shown/hidden), StyleManager.injectStyles(), MessageManager/MessageView (via content container) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/chat/modules/window/ChatWindow
 */

const StyleManager = require('./StyleManager');

class ChatWindow {
  constructor(options = {}) {
    // Configuration
    this.controller = options.controller || null;
    this.eventBus = options.eventBus || null;
    this.container = options.container || document.body;

    // State
    this.isVisible = false;
    this.isDetached = this._detectDetachedMode();
    this.element = null;

    // DOM element references (populated by createElements)
    this.elements = {
      window: null,
      header: null,
      title: null,
      controls: null,
      content: null,
      inputWrapper: null,
      input: null,
      sendBtn: null,
      fileBtn: null,
      fileInput: null
    };

    // Modules
    this.styleManager = new StyleManager();

    // Bind methods
    this._handleVisibilityRequest = this._handleVisibilityRequest.bind(this);

    console.log(`[ChatWindow] Constructed in ${this.isDetached ? 'detached' : 'attached'} mode`);
  }

  async init() {
    console.log('[ChatWindow] Initializing...');

    try {
      this.styleManager.injectStyles();
      this.createElements();
      this.setupEventListeners();

      if (this.isDetached) {
        this.show();
      } else {
        this.hide();
      }

      console.log('[ChatWindow] Initialization complete');
    } catch (error) {
      console.error('[ChatWindow] Initialization failed:', error);
      throw error;
    }
  }

  createElements() {
    const windowEl = document.createElement('div');
    windowEl.className = `aether-chat-window ${this.isDetached ? 'detached' : 'attached'}`;
    windowEl.id = 'aether-chat-window';

    const header = document.createElement('div');
    header.className = 'aether-chat-header';

    const title = document.createElement('div');
    title.className = 'aether-chat-title';
    title.textContent = 'New Chat';

    const controls = document.createElement('div');
    controls.className = 'aether-chat-controls';

    // Add New Chat button
    const newChatBtn = this._createControlButton('＋', 'New Chat', () => {
      if (this.eventBus) {
        this.eventBus.emit('chat:new-requested');
      }
    });
    controls.appendChild(newChatBtn);

    // Add Clear Chat button
    const clearChatBtn = this._createControlButton('⌫', 'Clear Chat', () => {
      if (this.eventBus) {
        this.eventBus.emit('chat:clear-requested');
      }
    });
    controls.appendChild(clearChatBtn);

    // Add control buttons for all modes
    // In detached mode, close button closes the window via IPC
    // In attached mode, close button hides the overlay
    if (this.isDetached) {
      const closeBtn = this._createControlButton('✕', 'Close', () => {
        // Send IPC to close window (hide, not destroy)
        if (window.aether && window.aether.ipc && window.aether.ipc.send) {
          window.aether.ipc.send('chat:window-control', 'close');
        }
      });
      controls.appendChild(closeBtn);
    } else {
      const minimizeBtn = this._createControlButton('─', 'Minimize', () => this.hide());
      const closeBtn = this._createControlButton('✕', 'Close', () => this.hide());
      controls.appendChild(minimizeBtn);
      controls.appendChild(closeBtn);
    }

    header.appendChild(title);
    header.appendChild(controls);

    // Create content area
    const content = document.createElement('div');
    content.className = 'aether-chat-content';
    content.id = 'aether-chat-content';

    // Create input wrapper
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'aether-chat-input-wrapper';

    // Create file button
    const fileBtn = document.createElement('button');
    fileBtn.className = 'aether-chat-btn aether-chat-file-btn';
    fileBtn.innerHTML = '📎';
    fileBtn.title = 'Attach file';
    fileBtn.setAttribute('aria-label', 'Attach file');

    // Create hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.multiple = true;
    fileInput.accept = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.html,.xml,.rtf,.odt,.ods,.odp,.csv,.tsv,.json,.jpg,.jpeg,.png,.gif,.bmp,.tiff,.tif,.webp,.svg,.ico,.mp3,.wav,.aac,.flac,.ogg,.m4a,.wma,.py,.js,.java,.cpp,.c,.h,.ts,.jsx,.tsx,.vue,.php,.rb,.go,.rs,.sh,.bat,.ps1,.sql,.yml,.yaml,.toml,.ini,.cfg,.conf,.log,.tex,.bib,.epub,.mp4,.avi,.mov,.mkv,.webm,.wmv,.flv,.3gp,.m4v';

    fileBtn.addEventListener('click', () => fileInput.click());

    // Create text input
    const input = document.createElement('textarea');
    input.className = 'aether-chat-input';
    input.id = 'aether-chat-input';
    input.placeholder = 'Type a message...';
    input.rows = 1;
    input.setAttribute('aria-label', 'Message input');

    // Create send button
    const sendBtn = document.createElement('button');
    sendBtn.className = 'aether-chat-btn aether-chat-send-btn';
    sendBtn.innerHTML = '▶';
    sendBtn.title = 'Send message';
    sendBtn.setAttribute('aria-label', 'Send message');

    // Assemble input wrapper
    inputWrapper.appendChild(fileBtn);
    inputWrapper.appendChild(input);
    inputWrapper.appendChild(sendBtn);

    // Create file preview container (hidden by default)
    const filePreviewContainer = document.createElement('div');
    filePreviewContainer.className = 'aether-file-preview-container';
    filePreviewContainer.style.display = 'none';
    filePreviewContainer.style.borderTop = '1px solid rgba(255,255,255,0.1)';
    filePreviewContainer.style.fontSize = '12px';

    const previewHeader = document.createElement('div');
    previewHeader.className = 'preview-header';
    previewHeader.style.cssText = 'display:flex;align-items:center;padding:8px 16px;cursor:pointer;gap:8px;';

    const fileNameSpan = document.createElement('span');
    fileNameSpan.className = 'file-name';
    fileNameSpan.style.cssText = 'flex:1;color:rgba(255, 255, 255, 0.9);';

    const clearFileBtn = document.createElement('button');
    clearFileBtn.className = 'clear-file-btn';
    clearFileBtn.textContent = '×';
    clearFileBtn.title = 'Clear all';
    clearFileBtn.style.cssText = 'background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:14px;';

    previewHeader.appendChild(fileNameSpan);
    previewHeader.appendChild(clearFileBtn);

    const fileList = document.createElement('ul');
    fileList.className = 'file-list';
    fileList.style.cssText = 'list-style:none;margin:0;padding:0 16px 8px 16px;display:none;';

    filePreviewContainer.appendChild(previewHeader);
    filePreviewContainer.appendChild(fileList);

    // Create image preview container (hidden by default)
    const imagePreviewContainer = document.createElement('div');
    imagePreviewContainer.className = 'aether-image-preview-container';
    imagePreviewContainer.style.cssText = 'position:relative;display:none;padding:10px;border-top:1px solid rgba(255, 255, 255, 0.1);';

    const imagePreview = document.createElement('img');
    imagePreview.className = 'aether-image-preview';
    imagePreview.alt = 'Image preview';
    imagePreview.style.cssText = 'max-width:100px;max-height:100px;border-radius:5px;border:1px solid rgba(255, 255, 255, 0.2);';

    const clearImageBtn = document.createElement('button');
    clearImageBtn.className = 'clear-image-btn';
    clearImageBtn.textContent = '×';
    clearImageBtn.title = 'Clear image';
    clearImageBtn.style.cssText = 'position:absolute;top:0px;right:0px;background:rgba(0, 0, 0, 0.7);color:white;border:none;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:12px;line-height:20px;text-align:center;';

    imagePreviewContainer.appendChild(imagePreview);
    imagePreviewContainer.appendChild(clearImageBtn);

    // Assemble window
    windowEl.appendChild(header);
    windowEl.appendChild(content);
    windowEl.appendChild(inputWrapper);
    windowEl.appendChild(filePreviewContainer);
    windowEl.appendChild(imagePreviewContainer);
    windowEl.appendChild(fileInput);

    // Add to container
    this.container.appendChild(windowEl);

    // Store references
    this.element = windowEl;
    this.elements = {
      window: windowEl,
      header,
      title,
      controls,
      content,
      inputWrapper,
      input,
      sendBtn,
      fileBtn,
      fileInput,
      filePreviewContainer,
      imagePreview,
      clearImageBtn,
      imagePreviewContainer
    };

    console.log('[ChatWindow] DOM elements created');
  }

  _createControlButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'aether-chat-control-btn';
    btn.innerHTML = label;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.addEventListener('click', onClick);
    return btn;
  }

  setupEventListeners() {
    if (this.eventBus) {
      this.eventBus.on('chat:show', this._handleVisibilityRequest);
      this.eventBus.on('chat:hide', this._handleVisibilityRequest);
      this.eventBus.on('chat:toggle', this._handleVisibilityRequest);
      this.eventBus.on('chat:title-changed', (data) => this._handleTitleChange(data));
    }

    console.log('[ChatWindow] Event listeners setup');
  }

  _handleVisibilityRequest(event) {
    const action = event.type || event;
    
    if (action === 'chat:show') {
      this.show();
    } else if (action === 'chat:hide') {
      this.hide();
    } else if (action === 'chat:toggle') {
      this.toggle();
    }
  }

  _handleTitleChange(data) {
    if (data && data.title) {
      this.setTitle(data.title);
    }
  }

  show() {
    if (!this.element) return;

    this.isVisible = true;
    this.element.classList.remove('hidden');

    if (this.elements.input) {
      setTimeout(() => {
        try {
          this.elements.input.focus();
        } catch (error) {
          console.warn('[ChatWindow] Failed to focus input:', error);
        }
      }, 100);
    }

    if (this.eventBus) {
      this.eventBus.emit('chat:window:shown', { timestamp: Date.now() });
    }

    console.log('[ChatWindow] Window shown');
  }

  hide() {
    if (!this.element) return;

    this.isVisible = false;
    this.element.classList.add('hidden');

    if (this.eventBus) {
      this.eventBus.emit('chat:window:hidden', { timestamp: Date.now() });
    }

    console.log('[ChatWindow] Window hidden');
  }

  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  _detectDetachedMode() {
    if (typeof window === 'undefined') return false;

    const isInChatHtml = window.location.pathname.includes('chat.html') ||
                        window.location.pathname.endsWith('chat.html');
    const hasDetachedFlag = window.DETACHED_CHAT === true;
    const hasDetachedAPI = window.aether && window.aether.isDetachedWindow === true;
    const detached = isInChatHtml || hasDetachedFlag || hasDetachedAPI;

    console.log(`[ChatWindow] Detached mode detection:`, {
      isInChatHtml,
      hasDetachedFlag,
      hasDetachedAPI,
      result: detached
    });

    return detached;
  }

  getState() {
    return Object.freeze({
      isVisible: this.isVisible,
      isDetached: this.isDetached,
      hasElement: !!this.element
    });
  }

  getElements() {
    return { ...this.elements };
  }

  setTitle(title) {
    if (this.elements.title) {
      const cleanTitle = (title || 'New Chat').trim();
      const truncatedTitle = cleanTitle.length > 50 ? cleanTitle.substring(0, 50) + '...' : cleanTitle;
      this.elements.title.textContent = truncatedTitle;
    }
  }

  dispose() {
    console.log('[ChatWindow] Disposing...');

    if (this.eventBus) {
      this.eventBus.off('chat:show', this._handleVisibilityRequest);
      this.eventBus.off('chat:hide', this._handleVisibilityRequest);
      this.eventBus.off('chat:toggle', this._handleVisibilityRequest);
    }

    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }

    if (this.styleManager) {
      this.styleManager.dispose();
    }

    this.element = null;
    this.elements = {};
    this.controller = null;
    this.eventBus = null;

    console.log('[ChatWindow] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatWindow;
}

if (typeof window !== 'undefined') {
  window.ChatWindow = ChatWindow;
  console.log('📦 ChatWindow loaded');
}

