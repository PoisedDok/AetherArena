'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const { getAether } = require('../../../shared/bridge/AetherBridge');

/**
 * @.architecture
 * Incoming: src/renderer/chat/controllers/ChatController.js, src/core/events/EventBus.js, DOM controls --- {event_types.custom_event, Event}
 * Processing: build chat window DOM, track detached visibility state, delegate styling and telemetry --- {4 jobs: JOB_CREATE_DOM_ELEMENT, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: src/renderer/chat/index.html, src/renderer/chat/modules/messaging/MessageManager.js, src/core/events/EventBus.js --- {dom_types.chat_entry_element, HTMLElement}
 */

const StyleManager = require('./StyleManager');
const CircularRingButton = require('../../components/CircularRingButton');
const ContextViewerModal = require('../../modals/ContextViewerModal');

class ChatWindow {
  constructor(options = {}) {
    // Configuration
    this.controller = options.controller || null;
    this.eventBus = options.eventBus || null;
    this.container = options.container || document.body;
    this.endpoint = options.endpoint || null;
    this.log = createRendererLogger('ChatWindow');
    this.aether = options.aether || getAether();

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
      fileInput: null,
      contextRingButton: null
    };

    // Modules
    this.styleManager = new StyleManager();
    this.contextButton = null;
    this.contextModal = null;

    // Bind methods
    this._handleVisibilityRequest = this._handleVisibilityRequest.bind(this);
    this._handleTitleChange = this._handleTitleChange.bind(this);
    this._handleTitleDoubleClick = this._handleTitleDoubleClick.bind(this);
    this._handleChatLoaded = this._handleChatLoaded.bind(this);
    this._handleChatCreated = this._handleChatCreated.bind(this);
    this._handleMessageSent = this._handleMessageSent.bind(this);
    this._handleMessageReceived = this._handleMessageReceived.bind(this);
    this._handleStreamStarted = this._handleStreamStarted.bind(this);
    this._handleStreamChunk = this._handleStreamChunk.bind(this);
    this._handleStreamEnded = this._handleStreamEnded.bind(this);
    this._handleNotchModeChange = this._handleNotchModeChange.bind(this);

    // State for title editing
    this._isEditingTitle = false;

    // Real-time context state
    this._localTokenCount = 0;
    this._baseTokenCount = 0;
    this._contextRefreshThrottleTimer = null;
    this._lastContextRefreshTime = 0;
    this._isStreaming = false;

    // BUG CW-1 FIX: Lifecycle flag
    this._isDisposed = false;

    // BUG CW-2 FIX: Track document-level listener for cleanup
    this._documentClickHandler = null;
    
    // Track DOM element event listeners
    this._domListeners = [];

    // BUG CW-4 FIX: Track initial context refresh timer
    this._initContextTimer = null;

    // Click guard: prevent rapid repeated context viewer opens
    this._contextViewerOpening = false;

    // In-flight dedupe for context ring refresh
    this._contextRefreshInFlight = false;
    this._contextRefreshPending = false;

    // Header dblclick handler for clean work mode toggle (detached only)
    this._headerDblClickHandler = null;

    // Notch mode state
    this._isNotchMode = false;
    this._notchDblClickHandler = null;
    this._rightClickCount = 0;
    this._lastRightClickTime = 0;

    this.log.debug('constructed', { mode: this.isDetached ? 'detached' : 'attached' });
  }

  async init() {
    this.log.debug('initializing');

    try {
      this.styleManager.injectStyles();
      this.createElements();
      this.setupEventListeners();

      if (this.isDetached) {
        this.show();
      } else {
        this.hide();
      }

      this.log.debug('initialization complete');
    } catch (error) {
      this.log.error('initialization failed', { error });
      throw error;
    }
  }

  /**
   * Track DOM listener for cleanup
   * @private
   */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._domListeners.push({ element, event, handler, options });
  }

  createElements() {
    const windowEl = document.createElement('div');
    windowEl.className = `aether-chat-window ${this.isDetached ? 'detached' : 'attached'}`;
    windowEl.id = 'aether-chat-window';

    const header = document.createElement('div');
    header.className = 'aether-chat-header';
    
    // Enable window dragging by header in detached mode (Electron native drag)
    if (this.isDetached) {
      header.style.webkitAppRegion = 'drag';
    }

    const title = document.createElement('div');
    title.className = 'aether-chat-title';
    title.textContent = 'New Chat';
    title.title = 'Double-click to edit';

    const controls = document.createElement('div');
    controls.className = 'aether-chat-controls';

    // Add New Chat button (plus icon)
    const newChatBtn = this._createControlButton(
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
      'New Chat',
      () => {
        if (this.eventBus) {
          this.eventBus.emit('chat:new-requested');
        }
      }
    );
    controls.appendChild(newChatBtn);

    // Add control buttons for all modes
    // In detached mode, close button closes the window via IPC
    // In attached mode, close button hides the overlay
    if (this.isDetached) {
      const closeBtn = this._createControlButton(
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
        'Close',
        () => {
          if (this.aether?.ipc?.send) {
            this.aether.ipc.send('chat:window-control', 'close');
          }
        }
      );
      controls.appendChild(closeBtn);
    } else {
      const minimizeBtn = this._createControlButton(
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
        'Minimize',
        () => this.hide()
      );
      const closeBtn = this._createControlButton(
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
        'Close',
        () => this.hide()
      );
      controls.appendChild(minimizeBtn);
      controls.appendChild(closeBtn);
    }

    header.appendChild(title);
    header.appendChild(controls);

    // Create content area
    const content = document.createElement('div');
    content.className = 'aether-chat-content';
    content.id = 'aether-chat-content';

    const status = document.createElement('div');
    status.className = 'aether-chat-status';
    status.id = 'aether-chat-status';
    status.setAttribute('role', 'alert');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-hidden', 'true');

    // Create input wrapper
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'aether-chat-input-wrapper';

    // Create attachment button with dropdown menu
    const attachBtn = document.createElement('button');
    attachBtn.className = 'aether-chat-btn aether-chat-attach-btn';
    attachBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M8 12.5l6.5-6.5a3 3 0 014.24 4.24l-7.78 7.78a5 5 0 11-7.07-7.07l7.07-7.07"></path>
      </svg>
    `;
    attachBtn.title = 'Attach files or chats';
    attachBtn.setAttribute('aria-label', 'Attach files or chats');

    // Create attachment dropdown menu (styles in chat.css)
    const attachMenu = document.createElement('div');
    attachMenu.className = 'aether-attach-menu';

    // Files option
    const filesOption = document.createElement('button');
    filesOption.className = 'attach-menu-item';
    filesOption.setAttribute('aria-label', 'Attach files');
    filesOption.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
        <polyline points="13 2 13 9 20 9"></polyline>
      </svg>
      <span>Files</span>
    `;

    // Chats option
    const chatsOption = document.createElement('button');
    chatsOption.className = 'attach-menu-item';
    chatsOption.setAttribute('aria-label', 'Attach chats');
    chatsOption.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
      <span>Chats</span>
    `;

    attachMenu.appendChild(filesOption);
    attachMenu.appendChild(chatsOption);

    // Create hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.multiple = true;
    fileInput.accept = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.html,.xml,.rtf,.odt,.ods,.odp,.csv,.tsv,.json,.jpg,.jpeg,.png,.gif,.bmp,.tiff,.tif,.webp,.svg,.ico,.mp3,.wav,.aac,.flac,.ogg,.m4a,.wma,.py,.js,.java,.cpp,.c,.h,.ts,.jsx,.tsx,.vue,.php,.rb,.go,.rs,.sh,.bat,.ps1,.sql,.yml,.yaml,.toml,.ini,.cfg,.conf,.log,.tex,.bib,.epub,.mp4,.avi,.mov,.mkv,.webm,.wmv,.flv,.3gp,.m4v';

    // Attachment button click handler
    this._trackListener(attachBtn, 'click', (e) => {
      e.stopPropagation();
      const isVisible = attachMenu.style.display === 'block';
      attachMenu.style.display = isVisible ? 'none' : 'block';
    });

    // Files option click handler
    this._trackListener(filesOption, 'click', () => {
      attachMenu.style.display = 'none';
      fileInput.click();
    });

    // Chats option click handler - will be connected via event bus
    this._trackListener(chatsOption, 'click', () => {
      attachMenu.style.display = 'none';
      if (this.eventBus) {
        this.eventBus.emit('chat-reference:attach-requested-from-input', {
          sourceChatId: this._getCurrentChatId()
        });
      }
    });

    // Close menu when clicking outside
    // BUG CW-2 FIX: Store handler reference for cleanup in dispose
    this._documentClickHandler = (e) => {
      if (!attachBtn.contains(e.target) && !attachMenu.contains(e.target)) {
        attachMenu.style.display = 'none';
      }
    };
    document.addEventListener('click', this._documentClickHandler);

    // Create text input
    const input = document.createElement('textarea');
    input.className = 'aether-chat-input';
    input.id = 'aether-chat-input';
    input.placeholder = 'Type a message...';
    input.rows = 1;
    input.setAttribute('aria-label', 'Message input');
    input.setAttribute('spellcheck', 'true');
    input.setAttribute('autocorrect', 'on');
    input.setAttribute('autocapitalize', 'sentences');

    // Create context ring button (shows token usage, opens context viewer)
    this.contextButton = new CircularRingButton({
      onClick: () => this._openContextViewer()
    });
    const contextRingButtonEl = this.contextButton.getElement();

    // Create send button
    const sendBtn = document.createElement('button');
    sendBtn.className = 'aether-chat-btn aether-chat-send-btn';
    sendBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 12h12"></path>
        <path d="M13 6l6 6-6 6"></path>
      </svg>
    `;
    sendBtn.title = 'Send message';
    sendBtn.setAttribute('aria-label', 'Send message');

    // Assemble input wrapper
    inputWrapper.appendChild(attachBtn);
    inputWrapper.appendChild(attachMenu);
    inputWrapper.appendChild(input);
    inputWrapper.appendChild(contextRingButtonEl);
    inputWrapper.appendChild(sendBtn);

    // Create linked chats preview container (hidden by default, styles in chat.css)
    const linkedChatsContainer = document.createElement('div');
    linkedChatsContainer.className = 'aether-linked-chats-container';
    
    const linkedChatsHeader = document.createElement('div');
    linkedChatsHeader.className = 'linked-chats-header';
    linkedChatsHeader.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
      </svg>
      <span class="linked-count">0 Linked Chats</span>
    `;
    
    const linkedChatsList = document.createElement('div');
    linkedChatsList.className = 'linked-chats-list';
    
    linkedChatsContainer.appendChild(linkedChatsHeader);
    linkedChatsContainer.appendChild(linkedChatsList);
    
    // Create premium file preview container (hidden by default)
    const filePreviewContainer = document.createElement('div');
    filePreviewContainer.className = 'aether-file-preview-container';
    filePreviewContainer.style.display = 'none';

    // Create image preview container (hidden by default, styles in chat.css)
    const imagePreviewContainer = document.createElement('div');
    imagePreviewContainer.className = 'aether-image-preview-container';

    const imagePreview = document.createElement('img');
    imagePreview.className = 'aether-image-preview';
    imagePreview.alt = 'Image preview';

    const clearImageBtn = document.createElement('button');
    clearImageBtn.className = 'clear-image-btn';
    clearImageBtn.textContent = 'x';
    clearImageBtn.title = 'Clear image';
    clearImageBtn.setAttribute('aria-label', 'Clear image');

    imagePreviewContainer.appendChild(imagePreview);
    imagePreviewContainer.appendChild(clearImageBtn);

    // Assemble window
    windowEl.appendChild(header);
    windowEl.appendChild(content);
    windowEl.appendChild(status);
    windowEl.appendChild(inputWrapper);
    windowEl.appendChild(linkedChatsContainer);
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
      attachBtn,
      attachMenu,
      fileInput,
      status,
      linkedChatsContainer,
      linkedChatsList,
      linkedChatsHeader,
      filePreviewContainer,
      imagePreview,
      clearImageBtn,
      imagePreviewContainer,
      contextRingButton: contextRingButtonEl
    };

    this.log.trace('dom elements created');
  }

  /**
   * Open context viewer modal
   * @private
   */
  _openContextViewer() {
    if (this._isDisposed) return;
    if (this._contextViewerOpening) return;

    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Resolve chatId — try multiple sources to avoid silent failures
    let chatId = this._getCurrentChatId();
    if (!chatId) {
      chatId = this.element?.dataset?.chatId || null;
    }
    
    // CRITICAL UX FIX: If we have an existing modal but the chat ID has changed,
    // we MUST destroy it so it recreates with the correct ID.
    // The previous implementation tried to reuse it, causing it to be stuck on the old chat.
    if (this.contextModal && this.contextModal.chatId !== chatId) {
      this.log.debug(`Destroying stale context modal (was ${this.contextModal.chatId}, now ${chatId})`);
      try {
        this.contextModal.destroy();
      } catch (e) {
        this.log.warn('Error destroying stale context modal:', e);
      }
      this.contextModal = null;
    }

    if (!chatId) {
      this.log.warn('Cannot open context viewer: no active chat (controller.currentChatId=%s, element.dataset.chatId=%s)',
        this.controller?.currentChatId, this.element?.dataset?.chatId);
      return;
    }

    const endpoint = this.endpoint;
    if (!endpoint) {
      this.log.error('Cannot open context viewer: endpoint not available');
      return;
    }

    this._contextViewerOpening = true;

    // Destroy previous modal before creating a new one (as a safety measure)
    try {
      if (this.contextModal) {
        this.contextModal.destroy();
        this.contextModal = null;
      }
    } catch (destroyErr) {
      this.log.warn('Previous context modal destroy failed:', destroyErr);
      this.contextModal = null;
    }

    try {
      this.contextModal = new ContextViewerModal({
        eventBus: this.eventBus,
        endpoint: endpoint,
        chatId: chatId
      });

      this.contextModal.open();

      const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      this.log.debug('Context viewer opened', { chatId, openMs: Math.round(elapsed) });
    } catch (openErr) {
      this.log.error('Failed to open context viewer:', openErr);
      this.contextModal = null;
    } finally {
      this._contextViewerOpening = false;
    }
  }

  /**
   * Refresh context ring button display
   * Fetches current context snapshot from backend and updates button
   * @param {boolean} force - If true, bypasses throttling
   */
  async refreshContextDisplay(force = false) {
    if (this._isDisposed || !this.contextButton) return;

    // Throttle refreshing to avoid overloading backend (max once per 2 seconds during streaming)
    const now = Date.now();
    if (!force && this._isStreaming && now - this._lastContextRefreshTime < 2000) {
      if (!this._contextRefreshThrottleTimer) {
        this._contextRefreshThrottleTimer = setTimeout(() => {
          this._contextRefreshThrottleTimer = null;
          this.refreshContextDisplay();
        }, 2000 - (now - this._lastContextRefreshTime));
      }
      return;
    }

    // In-flight dedupe: skip if a request is already pending
    if (this._contextRefreshInFlight) {
      this._contextRefreshPending = true;
      return;
    }

    const chatId = this._getCurrentChatId();
    
    if (!chatId) {
      this.contextButton.updateDisplay({
        usage_percent: 0,
        token_count: 0,
        token_limit: 0,
        thresholds: { warning: 0, high: 0, critical: 0 }
      });
      return;
    }

    this._contextRefreshInFlight = true;
    try {
      const endpoint = this.endpoint;
      if (!endpoint) return;

      // PERF FIX: Use lightweight status endpoint instead of heavy context/messages.
      // The ring button only needs token usage stats, not full message payloads.
      const contextSnapshot = await endpoint.getContextStatus(chatId);
      if (this._isDisposed) return;

      this.contextButton.updateDisplay(contextSnapshot);
      
      this._baseTokenCount = contextSnapshot.token_count || 0;
      this._localTokenCount = this._baseTokenCount;
      this._lastContextRefreshTime = Date.now();
      
      this.log.trace('Context display refreshed', { chatId, tokenCount: contextSnapshot.token_count, usagePercent: contextSnapshot.usage_percent });
    } catch (error) {
      if (!error.isBackendUnavailableError) {
        this.log.error('Failed to refresh context display', { error, chatId });
      }
    } finally {
      this._contextRefreshInFlight = false;
      if (this._contextRefreshPending) {
        this._contextRefreshPending = false;
        this.refreshContextDisplay(true);
      }
    }
  }

  _createControlButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'aether-chat-control-btn';
    btn.innerHTML = label;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    this._trackListener(btn, 'click', onClick);
    return btn;
  }

  setupEventListeners() {
    if (this.eventBus) {
      this.eventBus.on('chat:show', this._handleVisibilityRequest);
      this.eventBus.on('chat:hide', this._handleVisibilityRequest);
      this.eventBus.on('chat:toggle', this._handleVisibilityRequest);
      this.eventBus.on('chat:title-changed', this._handleTitleChange);
      
      // Refresh context display on chat changes - using bound methods for proper cleanup
      // ARCHITECTURAL FIX: Use LOW priority to ensure ChatController updates currentChatId first
      this.eventBus.on(EventTypes.CHAT.LOADED, this._handleChatLoaded, { priority: EventPriority.LOW });
      this.eventBus.on(EventTypes.CHAT.SWITCHED, this._handleChatLoaded, { priority: EventPriority.LOW });
      this.eventBus.on(EventTypes.CHAT.CREATED, this._handleChatCreated);
      this.eventBus.on(EventTypes.CHAT.MESSAGE_SENT, this._handleMessageSent);
      this.eventBus.on(EventTypes.CHAT.MESSAGE_RECEIVED, this._handleMessageReceived);
      this.eventBus.on(EventTypes.CHAT.STREAM_STARTED, this._handleStreamStarted);
      this.eventBus.on(EventTypes.CHAT.STREAM_CHUNK, this._handleStreamChunk);
      this.eventBus.on(EventTypes.CHAT.STREAM_ENDED, this._handleStreamEnded);
    }

    // Add double-click listener for title editing
    if (this.elements.title) {
      this.elements.title.addEventListener('dblclick', this._handleTitleDoubleClick);
    }

    // Double-click on header (detached mode): toggle clean work mode via IPC.
    // Title dblclick calls stopPropagation(), so this only fires on the
    // header background area (the drag zone between title and controls).
    if (this.isDetached && this.elements.header) {
      this._headerDblClickHandler = (e) => {
        if (e.target.closest('.aether-chat-controls') || e.target.closest('.aether-chat-title')) return;
        if (this.aether?.ipc?.send) {
          this.aether.ipc.send('chat:window-control', 'toggle-clean-mode');
        }
      };
      this.elements.header.addEventListener('dblclick', this._headerDblClickHandler);
    }

    // Right double click on header to toggle notch mode
    this._notchDblClickHandler = (e) => {
      // Right click is button 2
      if (e.button === 2) {
        const now = Date.now();
        if (now - this._lastRightClickTime < 400) {
          this._rightClickCount++;
          if (this._rightClickCount === 2) {
            e.preventDefault();
            e.stopPropagation();
            if (this.aether?.ipc?.send) {
              this.aether.ipc.send('chat:window-control', 'toggle-notch-mode');
            }
            this._rightClickCount = 0;
          }
        } else {
          this._rightClickCount = 1;
        }
        this._lastRightClickTime = now;
      }
    };
    
    if (this.elements.header) {
      this.elements.header.addEventListener('mousedown', this._notchDblClickHandler);
    }

    // Notch proximity tracking via renderer mouse events
    this._notchMouseEnterHandler = () => {
      if (this._isNotchMode && this.aether?.chat?.reportNotchProximity) {
        this.aether.chat.reportNotchProximity(true);
      }
    };
    this._notchMouseLeaveHandler = () => {
      if (this._isNotchMode && this.aether?.chat?.reportNotchProximity) {
        this.aether.chat.reportNotchProximity(false);
      }
    };
    document.documentElement.addEventListener('mouseenter', this._notchMouseEnterHandler);
    document.documentElement.addEventListener('mouseleave', this._notchMouseLeaveHandler);

    // Listen for notch mode changes from main process
    if (this.aether && this.aether.chat && this.aether.chat.onNotchModeChanged) {
      this._notchModeCleanup = this.aether.chat.onNotchModeChanged(this._handleNotchModeChange);
    }

    // Listen for hide initiation
    if (this.aether && this.aether.windowControl && this.aether.windowControl.onInitiateHide) {
      this._hideInitiateCleanup = this.aether.windowControl.onInitiateHide(() => {
        if (!this.element) return;
        
        // If there's an existing hide in progress, clean it up first
        if (this._finishHideCallback) {
          this.element.removeEventListener('transitionend', this._finishHideCallback);
        }
        if (this._hideTimeoutFallback) {
          clearTimeout(this._hideTimeoutFallback);
          this._hideTimeoutFallback = null;
        }

        this.element.classList.add('hiding-transition');
        
        const finishHide = () => {
          this.element.removeEventListener('transitionend', finishHide);
          this._finishHideCallback = null;
          
          if (this._hideTimeoutFallback) {
            clearTimeout(this._hideTimeoutFallback);
            this._hideTimeoutFallback = null;
          }
          if (this.aether?.windowControl?.hideCompleted) {
            this.aether.windowControl.hideCompleted();
          }
          // We remove the class after hide is complete to ensure it's ready for next show
          requestAnimationFrame(() => {
            if (this.element) {
              this.element.classList.remove('hiding-transition');
            }
          });
        };

        this._finishHideCallback = finishHide;
        this.element.addEventListener('transitionend', finishHide);
        
        // Fallback in case transitionend doesn't fire
        this._hideTimeoutFallback = setTimeout(finishHide, 350);
      });
    }

    // Listen for hide cancellation (e.g. user double clicked header to show window before fade finished)
    if (this.aether && this.aether.windowControl && this.aether.windowControl.onCancelHide) {
      this._cancelHideCleanup = this.aether.windowControl.onCancelHide(() => {
        if (!this.element) return;
        
        // Clear timeout
        if (this._hideTimeoutFallback) {
          clearTimeout(this._hideTimeoutFallback);
          this._hideTimeoutFallback = null;
        }
        
        // Remove listener
        if (this._finishHideCallback) {
          this.element.removeEventListener('transitionend', this._finishHideCallback);
          this._finishHideCallback = null;
        }
        
        // Remove CSS class to immediately restore opacity
        requestAnimationFrame(() => {
          if (this.element) {
            this.element.classList.remove('hiding-transition');
          }
        });
      });
    }

    this.log.trace('event listeners setup');
    
    // Initialize context display after setup
    // BUG CW-4 FIX: Track timer for cleanup in dispose
    this._initContextTimer = setTimeout(() => {
      this._initContextTimer = null;
      this.refreshContextDisplay(true);
    }, 1000);
  }

  _handleChatLoaded() {
    this.refreshContextDisplay(true);
  }

  _handleChatCreated() {
    this.refreshContextDisplay(true);
  }

  _handleMessageSent() {
    this.refreshContextDisplay(true);
  }

  _handleMessageReceived() {
    this.refreshContextDisplay(true);
  }

  _handleStreamStarted(data) {
    // Filter by chatId
    const currentChatId = this._getCurrentChatId();
    if (data?.chatId && currentChatId && String(data.chatId) !== String(currentChatId)) {
      return;
    }
    this._isStreaming = true;
    this.refreshContextDisplay(true);
  }

  /**
   * Update context button in real-time during streaming
   * Performs local token estimation based on received chunks
   */
  _handleStreamChunk(data) {
    if (!this.contextButton || !data?.chunk) return;

    // Filter by chatId to prevent cross-chat UI contamination
    const currentChatId = this._getCurrentChatId();
    if (data.chatId && currentChatId && String(data.chatId) !== String(currentChatId)) {
      return;
    }

    // Conservative estimation: ~4 characters per token
    const estimatedNewTokens = Math.max(1, Math.floor(data.chunk.length / 4));
    this._localTokenCount += estimatedNewTokens;

    // Get current limit from button
    const limit = this.contextButton.tokenLimit || 1;
    const usagePercent = (this._localTokenCount / limit) * 100;

    // Update button display immediately (UI-only update)
    this.contextButton.updateDisplay({
      usage_percent: usagePercent,
      token_count: this._localTokenCount,
      token_limit: limit,
      thresholds: this.contextButton.thresholds // Preserve thresholds
    });

    // Also trigger throttled backend refresh
    this.refreshContextDisplay();
  }

  _handleStreamEnded(data) {
    // Filter by chatId
    const currentChatId = this._getCurrentChatId();
    if (data?.chatId && currentChatId && String(data.chatId) !== String(currentChatId)) {
      return;
    }
    this._isStreaming = false;
    if (this._contextRefreshThrottleTimer) {
      clearTimeout(this._contextRefreshThrottleTimer);
      this._contextRefreshThrottleTimer = null;
    }
    // Final refresh to get accurate count from backend
    this.refreshContextDisplay(true);
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

  _handleNotchModeChange(data) {
    if (data && data.enabled !== undefined) {
      this._isNotchMode = data.enabled;
      if (this.elements.window) {
        if (this._isNotchMode) {
          this.elements.window.classList.add('notch-mode');
        } else {
          this.elements.window.classList.remove('notch-mode');
        }
      }
    }
  }

  /**
   * Handle double-click on title to enable editing
   * @private
   */
  _handleTitleDoubleClick(event) {
    event.stopPropagation();
    
    if (this._isEditingTitle) return;
    
    this._isEditingTitle = true;
    const titleElement = this.elements.title;
    const currentTitle = titleElement.textContent.trim();
    
    this.log.debug('Title edit initiated', { currentTitle });
    
    // Create input element (styles in chat.css)
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.className = 'aether-chat-title-input';
    
    // Replace title with input
    titleElement.style.display = 'none';
    titleElement.parentNode.appendChild(input);
    
    // Focus and select
    input.focus();
    input.select();
    
    // Commit function
    const commitEdit = async () => {
      if (!this._isEditingTitle) return;
      
      // CRITICAL FIX: Prevent double execution (Enter key + blur can both trigger)
      this._isEditingTitle = false;
      
      const newTitle = input.value.trim();
      const finalTitle = newTitle || currentTitle;
      
      this.log.debug('Committing title edit', { from: currentTitle, to: finalTitle });
      
      // Update display immediately
      this.setTitle(finalTitle);
      
      // Save to database if title changed
      if (finalTitle !== currentTitle && finalTitle !== 'New Chat') {
        try {
          // Get current chat ID from controller or messageOrchestrator
          const chatId = this._getCurrentChatId();
          
          if (chatId) {
            this.log.debug('Updating chat title in database', { chatId, title: finalTitle });
            
            // Emit event for other components to handle (MessageOrchestrator listens to this)
            if (this.eventBus) {
              this.eventBus.emit('chat:title-update-requested', {
                chatId,
                title: finalTitle
              });
            }
          } else {
            this.log.warn('No chat ID available for title update');
          }
        } catch (error) {
          this.log.error('Failed to update chat title', { error });
        }
      }
      
      // Cleanup - check if input still exists in DOM
      if (input.parentNode) {
        input.remove();
      }
      titleElement.style.display = '';
    };
    
    // Cancel function
    const cancelEdit = () => {
      if (!this._isEditingTitle) return;
      
      this._isEditingTitle = false;
      
      this.log.debug('Title edit cancelled');
      
      // Cleanup - check if input still exists in DOM
      if (input.parentNode) {
        input.remove();
      }
      titleElement.style.display = '';
    };
    
    // Event listeners
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    });
    
    input.addEventListener('blur', () => {
      commitEdit();
    });
  }

  /**
   * Get current chat ID from controller
   * @private
   * @returns {string|null}
   */
  _getCurrentChatId() {
    // Try controller first
    if (this.controller && this.controller.currentChatId) {
      return this.controller.currentChatId;
    }
    
    // Try messageOrchestrator as fallback
    if (this.controller && this.controller.modules && this.controller.modules.messageOrchestrator) {
      const orchestrator = this.controller.modules.messageOrchestrator;
      if (orchestrator.messageState && orchestrator.messageState.currentChatId) {
        return orchestrator.messageState.currentChatId;
      }
    }
    
    return null;
  }

  show() {
    if (this._isDisposed || !this.element) return; // BUG CW-1 FIX

    this.isVisible = true;
    this.element.classList.remove('hidden');

    if (this.elements.input) {
      setTimeout(() => {
        try {
          this.elements.input.focus();
        } catch (error) {
          this.log.warn('failed to focus input field', { error });
        }
      }, 100);
    }

    if (this.eventBus) {
      this.eventBus.emit('chat:window:shown', { timestamp: Date.now() });
    }

    this.log.trace('window shown');
  }

  hide() {
    if (this._isDisposed || !this.element) return; // BUG CW-1 FIX

    this.isVisible = false;
    this.element.classList.add('hidden');

    if (this.eventBus) {
      this.eventBus.emit('chat:window:hidden', { timestamp: Date.now() });
    }

    this.log.trace('window hidden');
  }

  toggle() {
    if (this._isDisposed) return; // BUG CW-1 FIX
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
    const hasDetachedAPI = this.aether && this.aether.isDetachedWindow === true;
    const detached = isInChatHtml || hasDetachedFlag || hasDetachedAPI;

    this.log.trace('detached mode detection', {
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
    if (this._isDisposed) return; // BUG CW-1 FIX: Guard against double-dispose
    this._isDisposed = true; // BUG CW-1 FIX: Set FIRST — prevents callback re-entry
    this.log.info('disposing');

    // BUG CW-4 FIX: Clear initial context refresh timer
    if (this._initContextTimer) {
      clearTimeout(this._initContextTimer);
      this._initContextTimer = null;
    }

    // BUG CW-5 FIX: Clear context refresh throttle timer
    if (this._contextRefreshThrottleTimer) {
      clearTimeout(this._contextRefreshThrottleTimer);
      this._contextRefreshThrottleTimer = null;
    }

    // BUG CW-2 FIX: Remove document-level click listener
    if (this._documentClickHandler) {
      document.removeEventListener('click', this._documentClickHandler);
      this._documentClickHandler = null;
    }

    if (this.eventBus) {
      this.eventBus.off('chat:show', this._handleVisibilityRequest);
      this.eventBus.off('chat:hide', this._handleVisibilityRequest);
      this.eventBus.off('chat:toggle', this._handleVisibilityRequest);
      this.eventBus.off('chat:title-changed', this._handleTitleChange);
      this.eventBus.off(EventTypes.CHAT.LOADED, this._handleChatLoaded);
      this.eventBus.off(EventTypes.CHAT.SWITCHED, this._handleChatLoaded);
      this.eventBus.off(EventTypes.CHAT.CREATED, this._handleChatCreated);
      this.eventBus.off(EventTypes.CHAT.MESSAGE_SENT, this._handleMessageSent);
      this.eventBus.off(EventTypes.CHAT.MESSAGE_RECEIVED, this._handleMessageReceived);
      this.eventBus.off(EventTypes.CHAT.STREAM_STARTED, this._handleStreamStarted);
      this.eventBus.off(EventTypes.CHAT.STREAM_CHUNK, this._handleStreamChunk);
      this.eventBus.off(EventTypes.CHAT.STREAM_ENDED, this._handleStreamEnded);
    }

    // Remove title double-click listener
    if (this.elements.title) {
      this.elements.title.removeEventListener('dblclick', this._handleTitleDoubleClick);
    }

    if (this._notchMouseEnterHandler) {
      document.documentElement.removeEventListener('mouseenter', this._notchMouseEnterHandler);
      this._notchMouseEnterHandler = null;
    }
    
    if (this._notchMouseLeaveHandler) {
      document.documentElement.removeEventListener('mouseleave', this._notchMouseLeaveHandler);
      this._notchMouseLeaveHandler = null;
    }

    // Remove header dblclick listener (clean mode toggle)
    if (this._headerDblClickHandler && this.elements.header) {
      this.elements.header.removeEventListener('dblclick', this._headerDblClickHandler);
      this._headerDblClickHandler = null;
    }

    // Remove notch mode dblclick listener
    if (this._notchDblClickHandler && this.elements.header) {
      this.elements.header.removeEventListener('mousedown', this._notchDblClickHandler);
      this._notchDblClickHandler = null;
    }

    if (this._notchModeCleanup) {
      this._notchModeCleanup();
      this._notchModeCleanup = null;
    }

    if (this._hideInitiateCleanup) {
      this._hideInitiateCleanup();
      this._hideInitiateCleanup = null;
    }
    if (this._cancelHideCleanup) {
      this._cancelHideCleanup();
      this._cancelHideCleanup = null;
    }
    if (this._hideTimeoutFallback) {
      clearTimeout(this._hideTimeoutFallback);
      this._hideTimeoutFallback = null;
    }
    if (this._finishHideCallback && this.element) {
      this.element.removeEventListener('transitionend', this._finishHideCallback);
      this._finishHideCallback = null;
    }

    // Remove DOM listeners
    if (this._domListeners) {
      for (const { element, event, handler, options } of this._domListeners) {
        try {
          if (element) element.removeEventListener(event, handler, options);
        } catch (error) {
          this.log.warn('failed to remove DOM listener', { error });
        }
      }
      this._domListeners = [];
    }

    // Dispose context components
    if (this.contextButton) {
      this.contextButton.dispose();
      this.contextButton = null;
    }

    if (this.contextModal) {
      this.contextModal.destroy();  // CRITICAL FIX: BaseModal uses destroy() not dispose()
      this.contextModal = null;
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

    this.log.debug('disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatWindow;
}

if (typeof window !== 'undefined') {
  window.ChatWindow = ChatWindow;
  createRendererLogger('ChatWindow').debug('module loaded');
}
