/**
 * @.architecture
 *
 * Incoming: EventBus events (UI.SETTINGS_*, UI.NOTIFICATION, CONNECTION.STATUS_CHANGED, AUDIO.STT_FINAL, modal:*, proactive:*) --- {eventBus_types.event}
 * Processing: Route EventBus events to UI actions (settings, notifications, modals, artifacts, proactive), display notifications via Toast --- {2 jobs: JOB_ROUTE, JOB_RENDER}
 * Outgoing: DOM updates (notification text, connection label), IPC sends (chat, artifacts), Toast calls --- {dom_types.textContent, ipc_types.send, toast_types.call}
 *
 * Extracted from MainApp.js to reduce god-object size.
 */

'use strict';

const { EventTypes } = require('../../../../core/events/EventTypes');
const Toast = require('../../../shared/components/Toast');
const { createRendererLogger } = require('../../../shared/utils/logger');

class EventBusBridge {
  /**
   * @param {Object} options
   * @param {Object} options.eventBus - EventBus instance
   * @param {Object} options.elements - DOM elements { settingsStatus, connectionStatus }
   * @param {Object} options.aether - Aether bridge (for IPC)
   * @param {Object} options.endpoint - Endpoint instance
   * @param {Object} options.guru - GuruConnection instance (for state reads)
   * @param {Object} options.callbacks - Action callbacks from MainApp
   */
  constructor(options = {}) {
    this.log = createRendererLogger('EventBusBridge');
    this.eventBus = options.eventBus || null;
    this.elements = options.elements || {};
    this.aether = options.aether || null;
    this.endpoint = options.endpoint || null;
    this.guru = options.guru || null;
    this.callbacks = options.callbacks || {};

    this._isDisposed = false;
    this._cleanup = [];
    this._statusMessageTimeout = null;
  }

  /**
   * Bind all EventBus listeners.
   */
  bind() {
    if (this._isDisposed) return;
    if (!this.eventBus) {
      this.log.warn('EventBus unavailable; UI bridge disabled');
      return;
    }

    const cb = this.callbacks;

    const unsubscribers = [
      this.eventBus.on(EventTypes.UI.SETTINGS_OPENED, () => {
        if (cb.openSettings) cb.openSettings();
      }),
      this.eventBus.on(EventTypes.UI.SETTINGS_CLOSED, () => {
        if (cb.closeSettings) cb.closeSettings();
      }),
      this.eventBus.on(EventTypes.UI.TAB_CHANGED, (payload = {}) => {
        if (payload.tab && cb.switchSettingsTab) cb.switchSettingsTab(payload.tab);
      }),
      this.eventBus.on(EventTypes.UI.NOTIFICATION, (payload = {}) => {
        this._displayUiNotification(payload);
      }),
      this.eventBus.on(EventTypes.CONNECTION.STATUS_CHANGED, (payload = {}) => {
        this._updateConnectionIndicator(payload);
      }),

      // Handsfree mode: Refresh sidebar counts after STT final (user spoke)
      this.eventBus.on(EventTypes.AUDIO.STT_FINAL, (data) => {
        if (window.sidebarRefreshChannel && data) {
          const chatId = this.guru?.state?.activeChatId || null;
          if (chatId) {
            window.sidebarRefreshChannel.postMessage({
              type: 'chat_message_added',
              chat_id: chatId
            });
            this.log.debug('Sidebar refresh triggered for handsfree message');
          }
        }
      }),

      // ARCHITECTURAL FIX: Handle modal window requests within main window
      this.eventBus.on('modal:chat-new-requested', () => {
        if (this.aether?.ipc) {
          this.aether.ipc.send('chat:new-requested');
        }
      }),
      this.eventBus.on('modal:chat-open-requested', (payload) => {
        if (payload?.chatId && this.aether?.ipc) {
          this.aether.ipc.send('chat:switch-to-chat', { chatId: payload.chatId });
        }
      }),

      // Proactive: Open chat with pre-loaded context
        this.eventBus.on('proactive:open-chat', (payload) => {
          if (this.aether?.ipc) {
            this.log.debug('Opening chat with proactive context:', payload);
            this.aether.ipc.send('chat:proactive-context', {
              initialMessage: payload.initialMessage,
              runId: payload.runId,
              isProactive: true
            });
          }
        }),

      this.eventBus.on('modal:artifact-edit-requested', (payload) => {
        if (payload?.artifactId && this.aether?.ipc) {
          this.log.warn('Artifact edit not yet implemented', payload);
        }
      }),
      this.eventBus.on('modal:artifact-view-requested', async (payload) => {
        if (payload?.artifactId && this.aether?.ipc && this.endpoint) {
          try {
            const artifact = await this.endpoint.getArtifact(payload.artifactId);
            if (!artifact) {
              this.log.error('Artifact not found:', payload.artifactId);
              return;
            }

            let format = 'text';
            if (artifact.type === 'html' || (artifact.content && artifact.content.trim().startsWith('<'))) {
              format = 'html';
            } else if (artifact.type === 'markdown' || artifact.filename?.endsWith('.md')) {
              format = 'markdown';
            } else if (artifact.type === 'json' || artifact.filename?.endsWith('.json')) {
              format = 'json';
            }

            this.aether.ipc.send('artifacts:switch-tab', 'output');
            this.aether.ipc.send('artifacts:load-output', {
              output: artifact.content || '',
              format: format
            });
          } catch (error) {
            this.log.error('Failed to load artifact:', error);
          }
        }
      })
    ];

    this._cleanup = unsubscribers;
  }

  // ── Notification Display ───────────────────────────────────

  _displayUiNotification(payload = {}) {
    const statusEl = this.elements.settingsStatus;
    if (!payload.message) return;

    const type = payload.type || 'info';
    const duration = typeof payload.duration === 'number' ? payload.duration : 3000;

    // 1. Update modal status text (if modal is open)
    if (statusEl) {
      statusEl.textContent = payload.message;
      statusEl.className = `status-message status-${type}`;

      this._clearStatusMessageTimeout();

      if (duration > 0) {
        this._statusMessageTimeout = setTimeout(() => {
          statusEl.textContent = '';
          statusEl.className = 'status-message';
          this._statusMessageTimeout = null;
        }, duration);
      }
    }

    // 2. Always show premium Toast for global visibility
    if (type === 'success') Toast.success(payload.message, duration);
    else if (type === 'error') Toast.error(payload.message, duration);
    else if (type === 'warning') Toast.warning(payload.message, duration);
    else Toast.info(payload.message, duration);
  }

  _updateConnectionIndicator(data = {}) {
    const statusEl = this.elements.connectionStatus;
    if (!statusEl) return;

    const label = data.details?.state
      ? data.details.state.toUpperCase()
      : (data.connected ? 'ONLINE' : 'OFFLINE');

    statusEl.textContent = label;
    statusEl.style.color = data.connected ? 'var(--color-text-primary)' : 'var(--color-error)';

    // GAP 7 FIX: Show Toast on status change for better visibility
    if (data.connected && !data.previous) {
      Toast.success('Backend connection restored');
    } else if (!data.connected && data.previous) {
      Toast.error('Backend connection lost. Check Docker services.');
    }
  }

  _clearStatusMessageTimeout() {
    if (this._statusMessageTimeout) {
      clearTimeout(this._statusMessageTimeout);
      this._statusMessageTimeout = null;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────

  unbind() {
    this._clearStatusMessageTimeout();
    for (const unsubscribe of this._cleanup) {
      try {
        if (typeof unsubscribe === 'function') unsubscribe();
      } catch (error) {
        this.log.error('Failed to cleanup UI bridge listener:', error);
      }
    }
    this._cleanup = [];
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.unbind();
    this.eventBus = null;
    this.elements = {};
    this.aether = null;
    this.endpoint = null;
    this.guru = null;
    this.callbacks = {};
  }
}

module.exports = EventBusBridge;
