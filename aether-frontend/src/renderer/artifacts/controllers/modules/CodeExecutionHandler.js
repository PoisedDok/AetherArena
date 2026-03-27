'use strict';

/**
 * @.architecture
 *
 * Incoming: CodeViewer execute / requestBackendExecution / executeHtmlInPlace calls --- {method_call, object}
 * Processing: Validate code, execute locally or route to backend, create output artifacts, persist updates --- {5 jobs: JOB_VALIDATE, JOB_EXECUTE_LOCAL, JOB_ROUTE_BACKEND, JOB_CREATE_OUTPUT, JOB_PERSIST}
 * Outgoing: EventBus execution events, IPC to main process, controller.loadArtifact / switchTab calls --- {event.custom | ipc.send | method_call, object}
 *
 * @module renderer/artifacts/controllers/modules/CodeExecutionHandler
 *
 * CodeExecutionHandler - Code Execution Workflows
 * ============================================================================
 * Extracted from ArtifactsController monolith. Owns local JS execution,
 * backend-routed execution, and HTML in-place execution flows.
 *
 * SINGLE RESPONSIBILITY: Execute code (local or remote), create result
 * artifacts, and persist updates.
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const {
  CodeExecutionValidator,
  ExecutionResultFormatter,
} = require('../../../../application/artifacts/ArtifactsServices');
const { createRendererLogger } = require('../../../shared/utils/logger');

const logger = createRendererLogger('CodeExecutionHandler');

class CodeExecutionHandler {
  /**
   * @param {Object} options
   * @param {Object}   options.eventBus           - EventBus instance
   * @param {Object}   options.aether             - Aether IPC bridge
   * @param {Function} options.getArtifactCache   - () => Map-like cache
   * @param {Function} options.getCurrentChatId   - () => string|null
   * @param {Function} options.getSessionStore    - () => ArtifactSessionStore
   * @param {Function} options.getCodeExecutor    - () => modules.codeExecutor
   * @param {Function} options.switchTab          - (tab) => void
   * @param {Function} options.loadArtifact       - (artifact, opts) => void
   * @param {Function} options.persistArtifact    - (payload) => Promise
   */
  constructor(options = {}) {
    this.eventBus = options.eventBus;
    this.aether = options.aether;
    this.getArtifactCache = options.getArtifactCache;
    this.getCurrentChatId = options.getCurrentChatId;
    this.getSessionStore = options.getSessionStore;
    this.getCodeExecutor = options.getCodeExecutor;
    this.switchTab = options.switchTab;
    this.loadArtifact = options.loadArtifact;
    this.persistArtifact = options.persistArtifact;
    this._isDisposed = false;

    this.log = logger.child({ scope: 'execution-handler' });
    this.log.debug('CodeExecutionHandler initialized');
  }

  /**
   * Execute code locally (JavaScript only via SafeCodeExecutor).
   *
   * @param {string} code     - Code to execute
   * @param {string} language - Programming language
   * @returns {Promise<Object>} Execution result
   */
  async executeCode(code, language) {
    if (this._isDisposed) return null;
    // Security validation BEFORE execution (fail-fast, no fallbacks)
    const validation = CodeExecutionValidator.validate(code, language);
    this.log.info('Code execution validated', {
      language: validation.language,
      codeLength: validation.codeLength,
      warnings: validation.warnings
    });

    this.eventBus.emit(EventTypes.ARTIFACTS.EXECUTION_STARTED, { language });

    try {
      const codeExecutor = this.getCodeExecutor();
      const result = await codeExecutor.executeJavaScript(code);

      // Create output artifact
      const outputArtifact = {
        id: `output_${Date.now()}`,
        type: 'console',
        format: 'text',
        content: ExecutionResultFormatter.format(result),
        role: 'computer',
        chatId: this.getCurrentChatId(),
        timestamp: Date.now(),
        executionResult: result
      };

      // CRITICAL: Switch to output tab FIRST, then load artifact without auto-switch
      this.switchTab('output');

      this.loadArtifact(outputArtifact, {
        autoSwitch: false,
        forceAutoSwitch: false,
        forceOutput: true,
        origin: 'execution',
        isFinal: true
      });

      this.getSessionStore().addArtifact(outputArtifact);

      // Emit events
      this.eventBus.emit(EventTypes.ARTIFACTS.EXECUTION_COMPLETE, { result, artifact: outputArtifact });
      this.eventBus.emit(EventTypes.ARTIFACTS.ARTIFACT_ADDED, {
        artifact: outputArtifact,
        chatId: outputArtifact.chatId
      });

      this.log.info('Execution output routed to output tab', {
        artifactId: outputArtifact.id,
        chatId: outputArtifact.chatId
      });

      return result;

    } catch (error) {
      this.log.error('Execution failed', { error });

      // Create error artifact
      const errorArtifact = {
        id: `error_${Date.now()}`,
        type: 'console',
        format: 'text',
        content: `Execution Error:\n\n${error.message}\n\n${error.stack || ''}`,
        role: 'computer',
        chatId: this.getCurrentChatId(),
        timestamp: Date.now(),
        isError: true
      };

      this.switchTab('output');

      this.loadArtifact(errorArtifact, {
        autoSwitch: false,
        forceAutoSwitch: false,
        forceOutput: true,
        origin: 'execution',
        isFinal: true
      });

      this.getSessionStore().addArtifact(errorArtifact);

      this.eventBus.emit(EventTypes.ARTIFACTS.EXECUTION_ERROR, { error, artifact: errorArtifact });
      this.eventBus.emit(EventTypes.ARTIFACTS.ARTIFACT_ADDED, {
        artifact: errorArtifact,
        chatId: errorArtifact.chatId
      });

      throw error;
    }
  }

  /**
   * Request backend execution of edited code (via main-process IPC routing).
   *
   * @param {Object} req
   * @param {string} req.code
   * @param {string} req.language
   * @param {string|null} [req.artifactId]
   */
  async requestBackendExecution(req) {
    if (this._isDisposed) return;
    if (!req || typeof req !== 'object') {
      throw new Error('[CodeExecutionHandler] requestBackendExecution requires payload object');
    }
    const code = req.code;
    const language = req.language;
    const artifactId = req.artifactId || null;

    if (!code || typeof code !== 'string') {
      throw new Error('[CodeExecutionHandler] requestBackendExecution requires code (string)');
    }
    if (!language || typeof language !== 'string') {
      throw new Error('[CodeExecutionHandler] requestBackendExecution requires language (string)');
    }

    // Resolve chatId deterministically (no hardcoded fallbacks).
    let chatId = this.getCurrentChatId();
    if (!chatId && artifactId) {
      const cached = this.getArtifactCache().get(artifactId);
      const candidate = cached?.chatId || cached?.chat_id || null;
      if (candidate && typeof candidate === 'string') {
        chatId = candidate;
      }
    }
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('[CodeExecutionHandler] CONTRACT VIOLATION: Cannot execute without current chatId');
    }

    if (!this.aether?.ipc?.send) {
      throw new Error('[CodeExecutionHandler] CONTRACT VIOLATION: aether.ipc.send is required');
    }

    this.aether.ipc.send('artifacts:execute-code', {
      chatId,
      code,
      language,
      artifactId,
    });

    // CRITICAL: Switch to output tab immediately for instant UI feedback
    this.switchTab('output');

    this.log.info('Requested backend execution from artifacts window', {
      chatId: chatId.substring(0, 8),
      language,
      artifactId: artifactId ? artifactId.substring(0, 32) : null,
      codeLength: code.length,
    });
  }

  /**
   * Execute HTML by rendering it in Output tab and persisting updates to the
   * existing code/output artifacts (no new files).
   *
   * @param {Object} req
   * @param {string} req.code
   * @param {string} req.codeArtifactId
   */
  async executeHtmlInPlace(req) {
    if (this._isDisposed) return;
    if (!req || typeof req !== 'object') {
      throw new Error('[CodeExecutionHandler] executeHtmlInPlace requires payload object');
    }
    const code = req.code;
    const codeArtifactId = req.codeArtifactId || null;
    if (!code || typeof code !== 'string') {
      throw new Error('[CodeExecutionHandler] executeHtmlInPlace requires code (string)');
    }
    if (!codeArtifactId || typeof codeArtifactId !== 'string') {
      throw new Error('[CodeExecutionHandler] executeHtmlInPlace requires codeArtifactId (string)');
    }

    const artifactCache = this.getArtifactCache();
    const codeArtifact = artifactCache.get(codeArtifactId);
    if (!codeArtifact) {
      throw new Error('[CodeExecutionHandler] executeHtmlInPlace could not resolve code artifact from cache');
    }

    const chatId = codeArtifact.chatId || codeArtifact.chat_id || this.getCurrentChatId();
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('[CodeExecutionHandler] CONTRACT VIOLATION: executeHtmlInPlace requires chatId');
    }

    // Find the matching HTML output artifact for the same execution group.
    const execGroup = codeArtifact.executionGroup || codeArtifact.metadata?.execution_group || null;
    if (!execGroup || typeof execGroup !== 'string') {
      throw new Error('[CodeExecutionHandler] CONTRACT VIOLATION: executeHtmlInPlace requires executionGroup');
    }

    let outputArtifact = null;
    for (const a of artifactCache.values()) {
      const role = (a?.role || a?.metadata?.role || '').toLowerCase();
      if (role !== 'computer') continue;
      if (a?.type !== 'output') continue;
      const fmt = (a?.format || a?.language || '').toLowerCase();
      if (fmt !== 'html') continue;
      const g = a?.executionGroup || a?.metadata?.execution_group || null;
      if (g === execGroup) {
        outputArtifact = a;
        break;
      }
    }

    if (!outputArtifact) {
      throw new Error('[CodeExecutionHandler] executeHtmlInPlace could not find matching html output artifact in cache');
    }

    // Update artifacts in-memory (so UI refresh uses latest content).
    codeArtifact.content = code;
    outputArtifact.content = code;

    // Persist code update
    await this.persistArtifact({
      type: 'code',
      filename: codeArtifact.filename || 'code.html',
      content: code,
      language: 'html',
      artifact_id: codeArtifact.artifactId || codeArtifact.artifact_id || codeArtifact.id,
      message_id: codeArtifact.messageId || codeArtifact.message_id || null,
      chat_id: chatId,
      subgroup_id: codeArtifact.subgroup_id || null,
      node_id: codeArtifact.node_id || null,
      metadata: codeArtifact.metadata || { role: 'assistant' },
    });

    // Persist output update
    await this.persistArtifact({
      type: 'output',
      filename: outputArtifact.filename || 'output.html',
      content: code,
      language: 'html',
      artifact_id: outputArtifact.artifactId || outputArtifact.artifact_id || outputArtifact.id,
      message_id: outputArtifact.messageId || outputArtifact.message_id || null,
      chat_id: chatId,
      subgroup_id: outputArtifact.subgroup_id || null,
      node_id: outputArtifact.node_id || null,
      metadata: outputArtifact.metadata || { role: 'computer', format: 'html' },
    });

    // Display output immediately
    this.switchTab('output');
    this.loadArtifact(outputArtifact, {
      autoSwitch: false,
      forceAutoSwitch: false,
      forceOutput: true,
      origin: 'html-execute-in-place',
      isFinal: true,
    });
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.eventBus = null;
    this.aether = null;
    this.getArtifactCache = null;
    this.getCurrentChatId = null;
    this.getSessionStore = null;
    this.getCodeExecutor = null;
    this.switchTab = null;
    this.loadArtifact = null;
    this.persistArtifact = null;
    this.log.debug('CodeExecutionHandler disposed');
  }
}

module.exports = { CodeExecutionHandler };
