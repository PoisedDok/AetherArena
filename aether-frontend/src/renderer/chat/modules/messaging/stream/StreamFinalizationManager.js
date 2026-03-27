'use strict';

/**
 * @.architecture
 *
 * Incoming: Stream completion signal, accumulated state --- {completion_signal | stream_state, void|object}
 * Processing: Persist message, update DOM, emit events, clear state --- {4 jobs: JOB_PERSIST_MESSAGE, JOB_UPDATE_DOM, JOB_EMIT_EVENT, JOB_CLEAR_STATE}
 * Outgoing: MessageState.saveMessage(), EventBus stream:finalized --- {persistence_call | event, void}
 *
 * @module renderer/chat/modules/messaging/stream/StreamFinalizationManager
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const finalizationLogger = createRendererLogger('StreamFinalizationManager');

/**
 * StreamFinalizationManager - Stream Completion Handler
 * ======================================================
 * 
 * SINGLE RESPONSIBILITY: Finalize stream and persist
 * 
 * RESPONSIBILITIES:
 * - Persist accumulated text to database
 * - Update message view with final ID
 * - Emit finalization events
 * - Guard against concurrent finalization
 * 
 * CONTRACTS:
 * - Delegates persistence to MessageState
 * - NO state management (uses StreamStateManager)
 * - Idempotent (safe to call multiple times)
 * 
 * @module renderer/chat/modules/messaging/stream/StreamFinalizationManager
 */
class StreamFinalizationManager {
  constructor(options = {}) {
    this.messageState = options.messageState || null;
    this.messageView = options.messageView || null;
    this.eventBus = options.eventBus || null;
    this.log = finalizationLogger.child({ scope: 'stream-finalization-manager' });

    if (!this.messageState) {
      throw new Error('[StreamFinalizationManager] messageState is REQUIRED');
    }

    if (!this.messageView) {
      throw new Error('[StreamFinalizationManager] messageView is REQUIRED');
    }

    // Finalization guard
    this._isFinalizingStream = false;
    this._pendingFinalization = null;
    this._isDisposed = false;

    this.log.info('StreamFinalizationManager initialized');
  }

  /**
   * Finalize stream
   * CRITICAL: Guards against concurrent finalization
   * @param {Object} state - Stream state
   * @param {string} state.messageId - Message ID
   * @param {string} state.requestId - Request ID
   * @param {string} state.accumulatedText - Accumulated text
   * @param {string} state.thinkingText - Thinking text
   * @returns {Promise<void>}
   */
  async finalize(state) {
    if (this._isDisposed) {
      this.log.warn('finalize called on disposed StreamFinalizationManager');
      return;
    }

    // Prevent concurrent finalization
    if (this._isFinalizingStream) {
      this.log.trace('Finalization already in progress, waiting for completion');
      if (this._pendingFinalization) {
        await this._pendingFinalization;
      }
      return;
    }

    const { messageId, requestId, accumulatedText, thinkingText } = state;

    if (!messageId) {
      this.log.warn('Nothing to finalize - missing message ID');
      return;
    }

    this.log.debug('Finalizing stream', { messageId, requestId });

    // Set finalization guard — must stay true until the outer await resolves.
    // BUG FIX: Previously, _isFinalizingStream and _pendingFinalization were cleared
    // inside the IIFE's finally block. The IIFE's finally runs BEFORE the outer await
    // resolves, creating a window where concurrent callers bypass the guard.
    // Fix: clear guards in an outer try/finally AFTER the await.
    // (Mirrors the identical fix already applied to StreamHandler._finalizeStream)
    this._isFinalizingStream = true;
    this._pendingFinalization = (async () => {
      try {
        // Persist message to database
        const savedMessage = await this.messageState.saveMessage({
          id: messageId,
          role: 'assistant',
          content: accumulatedText || '', // Can be empty if only artifacts
          timestamp: Date.now(),
          correlation_id: requestId
        });

        // LIFECYCLE GUARD: Abort if disposed during async saveMessage
        if (this._isDisposed) {
          this.log.warn('finalize aborted: disposed during saveMessage', { messageId });
          return;
        }

        // Update view if ID changed
        if (savedMessage && savedMessage.id !== messageId) {
          this.log.debug('Message ID updated post-persistence', {
            previousId: messageId,
            persistedId: savedMessage.id
          });

          const element = this.messageView.getMessageElement(messageId);
          if (element) {
            element.dataset.messageId = savedMessage.id;
            this.messageView.messageElements.delete(messageId);
            this.messageView.messageElements.set(savedMessage.id, element);
          }
        }

        // Emit finalization event
        const finalContentLength = (accumulatedText || '').length;
        const finalThinkingLength = (thinkingText || '').length;

        if (this.eventBus) {
          this.eventBus.emit('stream:finalized', {
            messageId: savedMessage?.id || messageId,
            requestId,
            contentLength: finalContentLength,
            thinkingLength: finalThinkingLength
          });
        }

        this.log.info('Stream finalized', {
          messageId: savedMessage?.id || messageId,
          requestId,
          contentLength: finalContentLength
        });
      } catch (error) {
        this.log.error('Stream finalization failed', { error });
      }
    })();

    // Wait for finalization, then clear guards — outer finally guarantees cleanup
    try {
      await this._pendingFinalization;
    } finally {
      this._isFinalizingStream = false;
      this._pendingFinalization = null;
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;

    this._isDisposed = true;
    this._isFinalizingStream = false;
    this._pendingFinalization = null;
    this.messageState = null;
    this.messageView = null;
    this.eventBus = null;
    this.log.info('StreamFinalizationManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StreamFinalizationManager;
}

if (typeof window !== 'undefined') {
  window.StreamFinalizationManager = StreamFinalizationManager;
}
