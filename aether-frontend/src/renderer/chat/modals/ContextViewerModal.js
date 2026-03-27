'use strict';

/**
 * @.architecture
 * Incoming: ChatController (user clicks context button), window.endpoint (from renderer.js) --- {user_click, chat_id, Endpoint}
 * Processing: Fetch current context messages, split system prompt and global memories into separate collapsible containers, render conversation turns --- {3 jobs: JOB_HTTP_REQUEST, JOB_CREATE_DOM_ELEMENT, JOB_RENDER}
 * Outgoing: DOM (modal overlay), visual display with collapsible system prompt + memories sections --- {HTMLElement}
 * 
 * @.security innerHTML audit: SAFE
 * Context messages rendered via textContent/pre elements. innerHTML only for static UI structure
 * (section headers, SVG icons, usage badges, empty states). Percentage values are Number-coerced.
 * 
 * @module renderer/chat/modals/ContextViewerModal
 */

const BaseModal = require('../../shared/modals/BaseModal');
const { EventTypes } = require('../../../core/events/EventTypes');
const Toast = require('../../shared/components/Toast');
const ConfirmDialog = require('../../shared/components/ConfirmDialog');
const { createRendererLogger } = require('../../shared/utils/logger');

/**
 * Context Viewer Modal
 * 
 * Displays the exact context messages that will be sent to the LLM on the next turn.
 * Shows system prompt, conversation history, and token usage statistics.
 */
class ContextViewerModal extends BaseModal {
  constructor(options = {}) {
    const { eventBus, endpoint, chatId, ...baseOptions } = options;
    
    super({
      ...baseOptions,
      id: 'context-viewer-modal',
      title: 'Context',
      maxWidth: '900px',
      height: '80vh'
    });
    this.log = createRendererLogger('ContextViewerModal');

    // Scope premium styling to this modal panel
    if (this.panel) {
      this.panel.id = this.id;
    }
    if (this.bodyEl) {
      this.bodyEl.classList.add('ctx-body');
    }
    
    this.endpoint = endpoint || null;
    this.eventBus = eventBus || null;
    this.chatId = chatId || null;
    
    // State
    this.contextData = null;
    this.messages = [];
    this._listeners = [];
    this._subscriptions = [];
    this._refreshTimer = null;
    this._isStreaming = false;
    this._liveIndicatorEl = null;
    this._requestSequence = 0;
    this._isLoading = false;
    
    this.log.debug('[ContextViewerModal] Initialized', { 
      chatId, 
      hasEndpoint: !!this.endpoint,
      endpointType: this.endpoint ? typeof this.endpoint : 'null'
    });
  }

  /**
   * Paint skeleton and kick off async data load.
   * Returns immediately so BaseModal.open() shows the overlay without waiting
   * for the network round-trip.
   */
  async _renderContent() {
    if (!this.endpoint) {
      this._clearBodyListeners();
      this.bodyEl.innerHTML = '<div class="modal-empty-state"><p>Endpoint not initialized</p></div>';
      return;
    }
    
    if (!this.chatId) {
      this._clearBodyListeners();
      this.bodyEl.innerHTML = '<div class="modal-empty-state"><p>No active chat</p></div>';
      return;
    }
    
    this._showSkeleton();

    // Data loads in background, renders when ready.
    // Errors are caught internally — no unhandled rejection.
    await this._loadContextData();
  }

  /** @private Paint the skeleton loading state */
  _showSkeleton() {
    this._clearBodyListeners();
    this.bodyEl.innerHTML = `
      <div class="skeleton-container">
        <div class="skeleton-row"><div class="skeleton-line skeleton-line--sm"></div><div class="skeleton-line skeleton-line--sm"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--md skeleton-line--thick"></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--full"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--sm skeleton-line--thick"></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--lg"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--md skeleton-line--thick"></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--full"></div></div>
      </div>`;
  }

  /**
   * Fetch context data asynchronously with stale-response guards.
   * Safe to call multiple times — only the latest request's result is rendered.
   * @private
   */
  async _loadContextData() {
    const requestId = ++this._requestSequence;
    this._isLoading = true;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

    try {
      const data = await this.endpoint.getContextMessages(this.chatId);

      // Stale-response guard: discard if a newer request was issued or modal closed/destroyed
      if (requestId !== this._requestSequence) return;
      if (!this.isOpen) return;

      this.contextData = data;
      this.messages = data.messages || [];

      const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      this.log.debug('[ContextViewerModal] Context loaded', {
        messageCount: this.messages.length,
        tokenCount: this.contextData.token_count,
        usagePercent: this.contextData.usage_percent,
        fetchMs: Math.round(elapsed)
      });

      this._renderUI();
    } catch (error) {
      if (requestId !== this._requestSequence) return;
      if (!this.isOpen) return;

      this.log.error('[ContextViewerModal] Failed to load context:', error);
      this._clearBodyListeners();
      this.bodyEl.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">Failed to Load Context</div>
          <div class="modal-empty-text">${error.message || 'Unknown error'}</div>
        </div>
      `;
    } finally {
      if (requestId === this._requestSequence) {
        this._isLoading = false;
      }
    }
  }

  _renderUI() {
    this._clearBodyListeners();
    while (this.bodyEl.firstChild) {
      this.bodyEl.removeChild(this.bodyEl.firstChild);
    }
    
    // Stats header
    const statsHeader = document.createElement('div');
    statsHeader.className = 'ctx-stats';
    
    const leftStats = document.createElement('div');
    leftStats.className = 'ctx-stats-left';
    
    leftStats.innerHTML = `
      <span style="font-size: var(--font-size-xs); letter-spacing: 0.3px;">Messages: <strong style="color: var(--color-text-primary); font-size: var(--font-size-sm);">${this.contextData?.message_count || 0}</strong></span>
      <span style="font-size: var(--font-size-xs); letter-spacing: 0.3px;">Tokens: <strong style="color: var(--color-text-primary); font-size: var(--font-size-sm);">${(this.contextData?.token_count || 0).toLocaleString()} / ${(this.contextData?.token_limit || 0).toLocaleString()}</strong></span>
    `;
    
    const rightStats = document.createElement('div');
    rightStats.className = 'ctx-stats-right';
    const usagePercent = this.contextData?.usage_percent || 0;
    
    // Use thresholds from backend for color coding
    const thresholds = this.contextData?.thresholds || { warning: 80, high: 90, critical: 95 };
    const limit = this.contextData?.token_limit || 1;
    
    // Calculate thresholds as percentages if they are absolute counts
    const warningP = thresholds.warning > 100 ? (thresholds.warning / limit) * 100 : thresholds.warning;
    const highP = thresholds.high > 100 ? (thresholds.high / limit) * 100 : thresholds.high;
    const criticalP = thresholds.critical > 100 ? (thresholds.critical / limit) * 100 : thresholds.critical;

    const usageTone = usagePercent >= criticalP ? 'error' :
      usagePercent >= highP ? 'warning' :
      usagePercent >= warningP ? 'info' : 'success';

    const usageColors = {
      error: { bg: 'var(--color-error-bg)', text: 'var(--color-error)', border: 'var(--color-error-border)' },
      warning: { bg: 'var(--color-warning-bg)', text: 'var(--color-warning)', border: 'var(--color-warning-border)' },
      info: { bg: 'var(--color-info-bg)', text: 'var(--color-info)', border: 'var(--color-info-border)' },
      success: { bg: 'var(--color-success-bg)', text: 'var(--color-success)', border: 'var(--color-success-border)' }
    }[usageTone];
    
    const liveIndicator = document.createElement('div');
    liveIndicator.className = 'ctx-live';
    this._liveIndicatorEl = liveIndicator;
    this._updateLiveIndicator();
    
    const usageBadgeContainer = document.createElement('div');
    usageBadgeContainer.className = 'ctx-usage-container'; // Need a class for querying
    usageBadgeContainer.style.setProperty('--ctx-usage-bg', usageColors.bg);
    usageBadgeContainer.style.setProperty('--ctx-usage-text', usageColors.text);
    usageBadgeContainer.style.setProperty('--ctx-usage-border', usageColors.border);
    usageBadgeContainer.innerHTML = `<span class="ctx-usage-badge">${usagePercent.toFixed(1)}% Used</span>`;
    
    rightStats.appendChild(liveIndicator);
    rightStats.appendChild(usageBadgeContainer);
    
    statsHeader.appendChild(leftStats);
    statsHeader.appendChild(rightStats);
    
    // Messages container
    const messagesContainer = document.createElement('div');
    messagesContainer.className = 'ctx-list';
    
    // Group messages: system (standalone), then user+assistant pairs
    const messageGroups = this._groupMessages(this.messages);
    
    // Render each group
    messageGroups.forEach((group, groupIndex) => {
      const groupCard = this._createGroupCard(group, groupIndex);
      messagesContainer.appendChild(groupCard);
    });
    
    // Empty state
    if (this.messages.length === 0) {
      messagesContainer.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">No Messages</div>
          <div class="modal-empty-text">Start a conversation to see context messages</div>
        </div>
      `;
    }
    
    this.bodyEl.appendChild(statsHeader);
    this.bodyEl.appendChild(messagesContainer);
  }

  /**
   * Group messages into displayable units:
   * - System messages standalone
   * - User+Assistant pairs grouped together
   */
  _groupMessages(messages) {
    const groups = [];
    let i = 0;
    
    while (i < messages.length) {
      const msg = messages[i];
      
      // System message = standalone group
      if (msg.is_system || msg.role === 'system') {
        groups.push({
          type: 'system',
          messages: [msg]
        });
        i++;
      }
      // User message = start of pair
      else if (msg.role === 'user') {
        const userMsg = msg;
        const assistantMsg = (i + 1 < messages.length && messages[i + 1].role === 'assistant') 
          ? messages[i + 1] 
          : null;
        
        groups.push({
          type: 'pair',
          messages: assistantMsg ? [userMsg, assistantMsg] : [userMsg],
          userMessageId: userMsg.id  // For deletion
        });
        
        i += assistantMsg ? 2 : 1;
      }
      // Assistant without user (shouldn't happen, but handle it)
      else if (msg.role === 'assistant') {
        groups.push({
          type: 'orphan',
          messages: [msg]
        });
        i++;
      }
      else {
        i++;  // Skip unknown roles
      }
    }
    
    return groups;
  }

  _setupEventListeners() {
    if (!this.eventBus) {
      return;
    }
    
    const subscribe = (eventName, handler, options = {}) => {
      const cleanup = this.eventBus.on(eventName, handler, options);
      if (cleanup) {
        this._subscriptions.push(cleanup);
      }
    };
    
    const refreshForChat = (data) => {
      if (!this.isOpen) return;
      if (data?.chatId && this.chatId && String(data.chatId) !== String(this.chatId)) {
        return;
      }
      this._scheduleRefresh();
    };
    
    subscribe(EventTypes.CHAT.MESSAGE_SENT, refreshForChat);
    subscribe(EventTypes.CHAT.MESSAGE_RECEIVED, refreshForChat);
    subscribe(EventTypes.CHAT.MESSAGE_DELETED, refreshForChat);
    subscribe(EventTypes.CHAT.REQUEST_COMPLETED, refreshForChat);
    subscribe(EventTypes.CHAT.REQUEST_COMPLETE, refreshForChat);
    subscribe(EventTypes.CHAT.STREAM_ENDED, refreshForChat);
    subscribe(EventTypes.CHAT.STREAM_ERROR, refreshForChat);
    subscribe(EventTypes.CHAT.STREAM_CHUNK, (data) => {
      if (data?.chatId && this.chatId && String(data.chatId) !== String(this.chatId)) {
        return;
      }
      this._handleStreamChunk(data);
    });
    
    // ARCHITECTURAL FIX: Listen to both SWITCHED and LOADED events for robust chat linking
    const handleChatSwitch = (data) => {
      if (!data?.chatId) return;
      
      if (String(data.chatId) !== String(this.chatId)) {
        this.log.debug(`[ContextViewerModal] Chat switched from ${this.chatId} to ${data.chatId}`);
        
        // CRITICAL FIX: Clear state immediately to prevent stale data sync during 300ms delay
        this.chatId = data.chatId;
        this.contextData = null;
        this.messages = [];
        
        // Clear UI immediately to show loading state
        if (this.isOpen && this.bodyEl) {
          this._showSkeleton();
        }
        
        this._scheduleRefresh();
      }
    };
    
    subscribe(EventTypes.CHAT.SWITCHED, handleChatSwitch);
    subscribe(EventTypes.CHAT.LOADED, handleChatSwitch);
    subscribe(EventTypes.CHAT.STREAM_STARTED, (data) => {
      if (data?.chatId && this.chatId && String(data.chatId) !== String(this.chatId)) {
        return;
      }
      this._setStreamingState(true);
    });
    subscribe(EventTypes.CHAT.STREAM_ENDED, (data) => {
      if (data?.chatId && this.chatId && String(data.chatId) !== String(this.chatId)) {
        return;
      }
      this._setStreamingState(false);
    });
    subscribe(EventTypes.CHAT.STREAM_ERROR, (data) => {
      if (data?.chatId && this.chatId && String(data.chatId) !== String(this.chatId)) {
        return;
      }
      this._setStreamingState(false);
    });
  }

  _scheduleRefresh() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    this._refreshTimer = setTimeout(() => {
      if (!this.isOpen) return;
      this._loadContextData();
    }, 300);
  }

  /**
   * Handle incoming stream chunk to update modal content in real-time
   * @private
   */
  _handleStreamChunk(data) {
    if (!this.isOpen || !data?.chunk) return;

    // 1. Update internal state
    if (!this.contextData) return;

    // Estimate tokens
    const estimatedNewTokens = Math.max(1, Math.floor(data.chunk.length / 4));
    this.contextData.token_count += estimatedNewTokens;
    this.contextData.usage_percent = (this.contextData.token_count / this.contextData.token_limit) * 100;

    // 2. Update UI Stats Header (if it exists)
    const tokenDisplay = this.bodyEl.querySelector('.ctx-stats-left strong:last-child');
    if (tokenDisplay) {
      tokenDisplay.textContent = `${this.contextData.token_count.toLocaleString()} / ${this.contextData.token_limit.toLocaleString()}`;
    }

    const usageBadgeContainer = this.bodyEl.querySelector('.ctx-usage-container');
    if (usageBadgeContainer) {
      const usageBadge = usageBadgeContainer.querySelector('.ctx-usage-badge');
      if (usageBadge) {
        usageBadge.textContent = `${this.contextData.usage_percent.toFixed(1)}% Used`;
        
        // Update color if threshold crossed - Use dynamic thresholds
        const usagePercent = this.contextData.usage_percent;
        const thresholds = this.contextData.thresholds || { warning: 80, high: 90, critical: 95 };
        const limit = this.contextData.token_limit || 1;
        
        const warningP = thresholds.warning > 100 ? (thresholds.warning / limit) * 100 : thresholds.warning;
        const highP = thresholds.high > 100 ? (thresholds.high / limit) * 100 : thresholds.high;
        const criticalP = thresholds.critical > 100 ? (thresholds.critical / limit) * 100 : thresholds.critical;

        const usageTone = usagePercent >= criticalP ? 'error' :
          usagePercent >= highP ? 'warning' :
          usagePercent >= warningP ? 'info' : 'success';

        const usageColors = {
          error: 'var(--color-error)',
          warning: 'var(--color-warning)',
          info: 'var(--color-info)',
          success: 'var(--color-success)'
        }[usageTone];
        const usageBgs = {
          error: 'var(--color-error-bg)',
          warning: 'var(--color-warning-bg)',
          info: 'var(--color-info-bg)',
          success: 'var(--color-success-bg)'
        }[usageTone];
        
        usageBadgeContainer.style.setProperty('--ctx-usage-bg', usageBgs);
        usageBadgeContainer.style.setProperty('--ctx-usage-text', usageColors);
      }
    }

    // 3. Update the message content in the list
    // Find the last assistant message container
    const turns = this.bodyEl.querySelectorAll('.ctx-turn');
    if (turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      const messages = lastTurn.querySelectorAll('div > div:last-child');
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        // Check if it's an assistant message (look for the badge above it)
        const badge = lastMessage.previousElementSibling;
        if (badge && badge.textContent === 'ASSISTANT') {
          lastMessage.textContent += data.chunk;
        }
      }
    }
  }

  _setStreamingState(isStreaming) {
    this._isStreaming = Boolean(isStreaming);
    this._updateLiveIndicator();
  }

  _updateLiveIndicator() {
    if (!this._liveIndicatorEl) return;
    const color = this._isStreaming ? 'var(--color-success)' : 'var(--color-text-tertiary)';
    const glow = this._isStreaming ? 'var(--color-success-glow)' : 'var(--color-border-subtle)';
    const border = this._isStreaming ? 'var(--color-success-border)' : 'var(--color-border-base)';
    const label = this._isStreaming ? 'Live' : 'Idle';
    this._liveIndicatorEl.innerHTML = `
      <span style="
        width: 8px;
        height: 8px;
        border-radius: var(--radius-full);
        background: ${color};
        box-shadow: 0 0 10px ${glow};
        display: inline-block;
      "></span>
      ${label}
    `;
    this._liveIndicatorEl.style.borderColor = border;
    this._liveIndicatorEl.style.color = color;
  }

  /**
   * Create visual card for a message group
   */
  _createGroupCard(group, groupIndex) {
    const card = document.createElement('div');
    
    // System message styling
    if (group.type === 'system') {
      return this._createSystemCard(group.messages[0]);
    }
    
    // User+Assistant pair styling
    card.className = 'ctx-turn';
    
    // Header with group badge and delete button
    const header = document.createElement('div');
    header.className = 'ctx-turn-header';
    
    const leftSection = document.createElement('div');
    leftSection.style.cssText = 'display: flex; gap: 12px; align-items: center;';
    
    const groupBadge = document.createElement('span');
    groupBadge.className = 'ctx-turn-badge';
    groupBadge.textContent = `Turn #${groupIndex + 1}`;
    
    leftSection.appendChild(groupBadge);
    
    // Delete button for the group (if user message exists)
    if (group.userMessageId) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'ctx-delete';
      deleteBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Delete Turn
      `;
      deleteBtn.title = 'Delete this turn (user + assistant + artifacts)';
      this._trackListener(deleteBtn, 'click', () => this._handleDelete(group.userMessageId));
      
      leftSection.appendChild(deleteBtn);
    }
    
    header.appendChild(leftSection);
    card.appendChild(header);
    
    // Render each message in the group
    group.messages.forEach((msg, msgIndex) => {
      const msgEl = this._createMessageInGroup(msg, msgIndex);
      card.appendChild(msgEl);
      
      // Add separator between user and assistant
      if (msgIndex === 0 && group.messages.length > 1) {
        const separator = document.createElement('div');
        separator.className = 'ctx-separator';
        card.appendChild(separator);
      }
    });
    
    return card;
  }

  /**
   * Create system message card (split into system prompt + global memories)
   */
  _createSystemCard(message) {
    const container = document.createElement('div');
    container.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 12px;
    `;
    
    // Extract content
    const fullContent = typeof message.content === 'string' 
      ? message.content 
      : message.content?.text || JSON.stringify(message.content, null, 2);
    
    // Split content: system prompt vs global memories vs chat memories vs API docs
    const globalMemoryMarkers = ['## 🧠 Global Memory Context', '## Global Memory Context'];
    const chatMemoryMarkers = ['## 💬 Chat Memory Context', '## Chat Memory Context', '## Chat-Specific Memory Context'];
    const apiDocsMarkers = ['## 🔌 Backend API Access', '## Backend API Access'];
    
    const resolveMarker = (candidates) => {
      let match = null;
      for (const marker of candidates) {
        const pos = fullContent.indexOf(marker);
        if (pos !== -1 && (!match || pos < match.pos)) {
          match = { pos, marker };
        }
      }
      return match;
    };
    
    const globalMarker = resolveMarker(globalMemoryMarkers);
    const chatMarker = resolveMarker(chatMemoryMarkers);
    const apiMarker = resolveMarker(apiDocsMarkers);
    
    const hasChatMemories = Boolean(chatMarker);
    const hasApiDocs = Boolean(apiMarker);
    
    let systemPromptContent = fullContent;
    let globalMemoriesContent = '';
    let chatMemoriesContent = '';
    let apiDocsContent = '';
    
    // Find all markers and their positions
    const markers = [];
    if (globalMarker) markers.push({ type: 'global', pos: globalMarker.pos });
    if (chatMarker) markers.push({ type: 'chat', pos: chatMarker.pos });
    if (apiMarker) markers.push({ type: 'api', pos: apiMarker.pos });
    
    // Sort markers by position
    markers.sort((a, b) => a.pos - b.pos);
    
    // Extract system prompt (everything before first marker)
    if (markers.length > 0) {
      systemPromptContent = fullContent.substring(0, markers[0].pos).trim();
    }
    
    // Extract each section between markers
    for (let i = 0; i < markers.length; i++) {
      const currentMarker = markers[i];
      const nextMarker = markers[i + 1];
      const endPos = nextMarker ? nextMarker.pos : fullContent.length;
      const sectionContent = fullContent.substring(currentMarker.pos, endPos).trim();
      
      if (currentMarker.type === 'global') {
        globalMemoriesContent = sectionContent;
      } else if (currentMarker.type === 'chat') {
        chatMemoriesContent = sectionContent;
      } else if (currentMarker.type === 'api') {
        apiDocsContent = sectionContent;
      }
    }
    
    // Create system prompt collapsible card
    const palettes = {
      system: {
        bg: 'var(--color-accent-soft)',
        border: 'var(--color-accent-border)',
        text: 'var(--color-accent)',
        hover: 'var(--color-accent-soft-strong)'
      },
      global: {
        bg: 'var(--color-info-bg)',
        border: 'var(--color-info-border)',
        text: 'var(--color-info)',
        hover: 'var(--color-info-bg-strong)'
      },
      chat: {
        bg: 'var(--color-warning-bg)',
        border: 'var(--color-warning-border)',
        text: 'var(--color-warning)',
        hover: 'var(--color-warning-bg-strong)'
      },
      api: {
        bg: 'var(--color-success-bg)',
        border: 'var(--color-success-border)',
        text: 'var(--color-success)',
        hover: 'var(--color-success-bg-strong)'
      },
      proactive: {
        bg: 'var(--color-accent-soft)',
        border: 'var(--color-accent-border)',
        text: 'var(--color-accent)',
        hover: 'var(--color-accent-soft-strong)'
      }
    };

    if (message.metadata && message.metadata.source === 'proactive_seed') {
      const proactiveCard = this._createCollapsibleCard({
        title: 'PROACTIVE CONTEXT',
        content: fullContent,
        palette: palettes.proactive,
        collapsed: true
      });
      container.appendChild(proactiveCard);
      return container;
    }

    const systemCard = this._createCollapsibleCard({
      title: 'SYSTEM PROMPT',
      content: systemPromptContent,
      palette: palettes.system,
      collapsed: true
    });
    
    container.appendChild(systemCard);
    
    // Create global memories collapsible card (always present)
    const globalMemoriesCard = this._createCollapsibleCard({
      title: 'GLOBAL MEMORIES',
      content: globalMemoriesContent || 'No global memories available for this chat.',
      palette: palettes.global,
      collapsed: true
    });
    
    container.appendChild(globalMemoriesCard);
    
    // User requested to hide chat memories in context modal, as it is in view memories modal
    // (Skipped rendering CHAT MEMORIES card)
    
    // Create API docs collapsible card (if exists)
    if (hasApiDocs && apiDocsContent) {
      const apiDocsCard = this._createCollapsibleCard({
        title: 'API REFERENCE',
        content: apiDocsContent,
        palette: palettes.api,
        collapsed: true
      });
      
      container.appendChild(apiDocsCard);
    }
    
    return container;
  }
  
  /**
   * Create a collapsible card
   */
  _createCollapsibleCard({ title, content, palette, collapsed = true }) {
    const card = document.createElement('div');
    card.className = `ctx-accordion${collapsed ? '' : ' is-open'}`;
    card.style.setProperty('--ctx-badge-bg', palette.bg);
    card.style.setProperty('--ctx-badge-border', palette.border);
    card.style.setProperty('--ctx-badge-text', palette.text);
    
    // Header (clickable)
    const header = document.createElement('div');
    header.className = 'ctx-accordion-header';
    
    const titleBadge = document.createElement('div');
    titleBadge.className = 'ctx-accordion-badge';
    titleBadge.textContent = title;
    
    const chevron = document.createElement('div');
    chevron.className = 'ctx-accordion-chevron';
    chevron.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    `;
    
    header.appendChild(titleBadge);
    header.appendChild(chevron);
    
    // Content (collapsible)
    const contentEl = document.createElement('div');
    contentEl.className = 'ctx-accordion-content';
    contentEl.textContent = content;
    
    // Toggle on header click
    let isCollapsed = collapsed;
    this._trackListener(header, 'click', () => {
      isCollapsed = !isCollapsed;
      card.classList.toggle('is-open', !isCollapsed);
    });
    
    card.appendChild(header);
    card.appendChild(contentEl);
    
    return card;
  }

  /**
   * Create individual message within a group
   */
  _createMessageInGroup(message, index) {
    const rolePalettes = {
      user: {
        bg: 'var(--color-info-bg)',
        text: 'var(--color-info)'
      },
      assistant: {
        bg: 'var(--color-success-bg)',
        text: 'var(--color-success)'
      }
    };
    
    const rolePalette = rolePalettes[message.role] || {
      bg: 'var(--color-surface-hover)',
      text: 'var(--color-text-tertiary)'
    };
    const container = document.createElement('div');
    
    // Role badge
    const roleBadge = document.createElement('div');
    roleBadge.style.cssText = `
      background: ${rolePalette.bg};
      color: ${rolePalette.text};
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      font-weight: var(--font-weight-semibold);
      font-size: var(--font-size-xs);
      text-transform: uppercase;
      letter-spacing: 0.7px;
      display: inline-block;
      margin-bottom: 12px;
    `;
    roleBadge.textContent = message.role.toUpperCase();
    
    // Content
    const content = document.createElement('div');
    content.style.cssText = `
      color: var(--color-text-secondary);
      line-height: 1.7;
      font-size: var(--font-size-sm);
      white-space: pre-wrap;
      word-break: break-word;
    `;
    content.textContent = typeof message.content === 'string' 
      ? message.content 
      : message.content?.text || JSON.stringify(message.content, null, 2);
    
    container.appendChild(roleBadge);
    container.appendChild(content);
    return container;
  }

  async _handleDelete(messageId) {
    if (!this.endpoint || !this.chatId) {
      this.log.error('[ContextViewerModal] Cannot delete: missing endpoint or chatId');
      return;
    }
    
    // Confirm deletion
    const confirmed = await ConfirmDialog.confirm({
      title: 'Delete message',
      message: 'Delete this message and its response? This will also delete all associated artifacts and attachments. This action cannot be undone.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger'
    });
    if (!confirmed) return;
    
    try {
      // Delete message group via API
      const result = await this.endpoint.deleteMessageGroup(this.chatId, messageId);
      
      this.log.debug('[ContextViewerModal] Message group deleted', result);
      
      // Emit event for chat UI to update
      if (this.eventBus) {
        this.eventBus.emit(EventTypes.CHAT.MESSAGE_DELETED, {
          chatId: this.chatId,
          messageId: messageId,
          deletedMessages: result.deleted_messages,
          deletedArtifacts: result.deleted_artifacts
        });
      }
      
      // Reload modal content to reflect deletion
      await this._loadContextData();
      
      // Show deletion feedback (use info, not success, for destructive actions)
      Toast.info(`Deleted ${result.deleted_messages} messages and ${result.deleted_artifacts} artifacts`);
      
    } catch (error) {
      this.log.error('[ContextViewerModal] Failed to delete message:', error);
      Toast.error(`Failed to delete: ${error.message || 'Unknown error'}`);
    }
  }
  
  /** @private Track a DOM listener for cleanup */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  /** @private Clear tracked listeners inside bodyEl */
  _clearBodyListeners() {
    if (!this.bodyEl) return;
    const remaining = [];
    for (const listener of this._listeners) {
      if (listener.element && this.bodyEl.contains(listener.element)) {
        listener.element.removeEventListener(listener.event, listener.handler, listener.options);
      } else {
        remaining.push(listener);
      }
    }
    this._listeners = remaining;
  }

  /** @private Remove all tracked DOM listeners */
  _clearListeners() {
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];
  }

  _cleanup() {
    // Invalidate any in-flight request so its callback is a no-op
    this._requestSequence++;
    this._isLoading = false;

    this._clearListeners();
    this.contextData = null;
    this.messages = [];
    if (this._liveIndicatorEl && this._liveIndicatorEl.parentNode) {
      this._liveIndicatorEl.parentNode.removeChild(this._liveIndicatorEl);
    }
    this._liveIndicatorEl = null;
    this._isStreaming = false;
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._subscriptions.length) {
      this._subscriptions.forEach((cleanup) => {
        try {
          cleanup();
        } catch (error) {
          this.log.warn('[ContextViewerModal] Failed to cleanup subscription', error);
        }
      });
    }
    this._subscriptions = [];
  }
}

module.exports = ContextViewerModal;
