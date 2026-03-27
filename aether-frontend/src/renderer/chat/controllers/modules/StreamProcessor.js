'use strict';

/**
 * @.architecture
 *
 * Incoming: IPC stream payloads (assistant-stream, request-complete), EventBus artifact:stream, trail node clicks --- {ipc.stream_payload | event.custom, json | object}
 * Processing: Enrich stream payloads, forward to EventBus/artifacts window, handle trail node click IPC --- {5 jobs: JOB_ENRICH_PAYLOAD, JOB_EMIT_EVENT, JOB_FORWARD_STREAM, JOB_UPDATE_STATE, JOB_SEND_IPC}
 * Outgoing: EventBus CHAT.ASSISTANT_STREAM | CHAT.REQUEST_COMPLETE | CHAT.WINDOW_OPENED, artifacts.streamReady(), IPC artifacts:show-artifact --- {event.custom | ipc.artifact_stream | ipc.message, json}
 *
 * @module renderer/chat/controllers/modules/StreamProcessor
 *
 * StreamProcessor - Stream & IPC Event Handler
 * ============================================================================
 * Extracted from ChatController monolith. Handles all incoming stream events
 * from the main process and coordinates EventBus emission + artifact forwarding.
 *
 * SINGLE RESPONSIBILITY: Process incoming IPC/EventBus stream events,
 * enrich payloads, forward to appropriate consumers.
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../shared/utils/logger');

const logger = createRendererLogger('StreamProcessor');

class StreamProcessor {
  constructor(options = {}) {
    if (!options.eventBus) {
      throw new Error('[StreamProcessor] eventBus is REQUIRED');
    }

    this.eventBus = options.eventBus;
    this.aether = options.aether || null;
    this.getChatWindow = options.getChatWindow || (() => null);
    this.onProcessingComplete = options.onProcessingComplete || (() => {});
    this.log = logger.child({ scope: 'stream-processor' });

    // Stream state
    this.currentStreamingMessageId = null;

    this.log.debug('StreamProcessor initialized');
  }

  /**
   * Handle assistant stream chunk.
   * Enriches payload with messageId and emits to EventBus.
   * @param {Object} payload - Stream payload from IPC
   */
  handleAssistantStream(payload) {
    try {
      if (!payload || typeof payload !== 'object') {
        this.log.warn('Assistant stream payload ignored: invalid structure', { payload });
        return;
      }

      // CONTRACT: Backend sends request_id (snake_case) - use it for request identification
      // Backend NO LONGER sends 'id' field - removed for clean architecture
      const messageId =
        payload.messageId ||
        payload.requestId ||
        payload.correlationId ||
        null;

      if (messageId) {
        this.currentStreamingMessageId = messageId;
      }

      const enrichedPayload = {
        ...payload,
        messageId: messageId || this.currentStreamingMessageId || null
      };

      this.eventBus.emit(EventTypes.CHAT.ASSISTANT_STREAM, enrichedPayload);

    } catch (error) {
      this.log.error('Handle assistant stream failed', { error });
    }
  }

  /**
   * Handle request complete.
   * Resets streaming state and emits to EventBus.
   * @param {Object} data - Completion data from IPC
   */
  handleRequestComplete(data) {
    try {
      this.currentStreamingMessageId = null;
      this.onProcessingComplete();

      this.eventBus.emit(EventTypes.CHAT.REQUEST_COMPLETE, {
        ...data,
        timestamp: Date.now()
      });

      this.log.debug('Request complete', data);

    } catch (error) {
      this.log.error('Handle request complete failed', { error });
    }
  }

  /**
   * Handle ensure visible event.
   * Shows chat window and emits window opened event.
   */
  handleEnsureVisible() {
    try {
      const chatWindow = this.getChatWindow();

      // Make chat window visible
      if (chatWindow && typeof chatWindow.show === 'function') {
        chatWindow.show();
      }

      // Emit chat window opened event
      if (this.eventBus && EventTypes.CHAT && EventTypes.CHAT.WINDOW_OPENED) {
        this.eventBus.emit(EventTypes.CHAT.WINDOW_OPENED, {
          window: 'chat',
          timestamp: Date.now()
        });
      }

      this.log.debug('Ensure visible triggered');

    } catch (error) {
      this.log.error('Handle ensure visible failed', { error });
    }
  }

  /**
   * Handle artifact stream - forward directly to artifacts window.
   * Normalization already handled by application/main/ArtifactsStreamOrchestrator.
   * @param {Object} data - Normalized artifact stream payload
   */
  handleArtifactStream(data) {
    try {
      // Forward normalized stream directly to artifacts window
      // Application layer already normalized and validated the payload
      if (this.aether?.artifacts?.streamReady) {
        this.aether.artifacts.streamReady(data?.data || data);
      } else {
        this.log.error('Artifacts window API unavailable');
      }
    } catch (error) {
      this.log.error('Artifact stream forwarding error', { error });
    }
  }

  /**
   * Handle trail node click intent by opening artifact in artifacts window.
   * Controller owns IPC side effects; renderer modules only emit intent events.
   * @param {Object} data - Trail node click data
   */
  handleTrailNodeClicked(data) {
    try {
      const artifactId = typeof data?.artifactId === 'string' ? data.artifactId.trim() : '';
      if (!artifactId) {
        return;
      }

      const phase = typeof data?.phase === 'string' ? data.phase.toLowerCase() : '';
      const artifactType = typeof data?.artifactType === 'string' ? data.artifactType.toLowerCase() : '';

      const tabMap = {
        write: 'code',
        execute: 'output',
        output: 'output',
      };

      const tab =
        tabMap[phase] ||
        (artifactType === 'code' ? 'code' : 'output');

      if (this.aether?.ipc?.send) {
        this.aether.ipc.send('artifacts:show-artifact', { artifactId, tab });
        this.log.debug('Trail node clicked - opening artifact', { artifactId: artifactId.substring(0, 40), tab });
      } else {
        this.log.warn('IPC unavailable; cannot open artifacts window from trail click', { tab });
      }
    } catch (error) {
      this.log.error('Failed to handle trail node click', { error });
    }
  }

  /**
   * Reset stream state (called when processing is stopped externally).
   */
  resetStreamState() {
    this.currentStreamingMessageId = null;
  }

  /**
   * Dispose and cleanup.
   */
  dispose() {
    this.currentStreamingMessageId = null;
    this.eventBus = null;
    this.aether = null;
    this.getChatWindow = null;
    this.onProcessingComplete = null;
    this.log.debug('StreamProcessor disposed');
  }
}

module.exports = StreamProcessor;
