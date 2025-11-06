'use strict';

/**
 * @.architecture
 * 
 * Incoming: IPC 'artifacts:stream' (from artifacts-preload.js) --- {artifact_types.* (code_artifact|output_artifact|console_artifact|html_artifact), json}
 * Processing: Track streaming artifacts in Map by ID, accumulate content chunks (start → content → end protocol), route by artifact type (code|output|console), apply syntax highlighting (highlight.js), update tabs, persist finalized artifacts in registry, switch tabs based on artifact type --- {6 jobs: JOB_ACCUMULATE, JOB_ROUTE_BY_TYPE, JOB_RENDER_MARKDOWN, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE}
 * Outgoing: DOM updates (code/output/files tabs), tab switches --- {dom_types.*, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/renderer
 * 
 * Artifacts Window Renderer - Production Edition
 * ============================================================================
 * Complete artifacts interface with code viewer, syntax highlighting,
 * output display, tab switching, and file export.
 * Properly handles streaming protocol: start → content chunks → end.
 * Browser-only, CSP-compliant, secure architecture.
 */

console.log('🚀 Artifacts Renderer: Starting...');

// ============================================================================
// Validation
// ============================================================================

if (!window.aether) {
  console.error('❌ Artifacts Renderer: Preload API not available');
  document.body.innerHTML = `
    <div style="padding: 40px; text-align: center; font-family: system-ui;">
      <h1 style="color: #ff4444;">Security Error</h1>
      <p>Preload API not available. Check artifacts-preload.js configuration.</p>
    </div>
  `;
  throw new Error('Preload API not found');
}

console.log('✅ Artifacts Renderer: Preload API available');
console.log('📦 Aether versions:', window.aether.versions);

// ============================================================================
// Artifacts Application Class
// ============================================================================

class ArtifactsApp {
  constructor() {
    this.currentTab = 'code';
    this.currentCode = '';
    this.currentLanguage = 'javascript';
    this.currentFilename = 'untitled.js';
    this.currentOutput = '';
    this.currentOutputFormat = 'text'; // Track output format for proper rendering
    this.artifacts = [];
    this.currentArtifactIndex = 0;
    this.elements = {};
    this.cleanupFunctions = [];
    
    // Stream accumulators for handling streaming artifacts
    this.activeStreams = new Map(); // artifactId -> {type, content, language, role, etc}
    this.currentChatId = null;
    this.currentMessageId = null;
    
    // Log throttling to prevent per-token console spam
    this._logThrottle = {
      lastLog: 0,
      interval: 1000, // Log progress at most once per second
      chunkCount: 0
    };
  }
  
  /**
   * Initialize application
   */
  async initialize() {
    console.log('🏗️  Initializing artifacts application...');
    
    try {
      // Cache DOM elements
      this.cacheElements();
      
      // Setup event listeners
      this.setupEventListeners();
      
      // Setup IPC listeners
      this.setupIPCListeners();
      
      // Initialize UI
      this.initializeUI();
      
      console.log('✅ Artifacts application initialized');
    } catch (error) {
      console.error('❌ Initialization failed:', error);
      this.showError('Failed to initialize artifacts application');
    }
  }
  
  /**
   * Cache DOM elements
   */
  cacheElements() {
    this.elements = {
      root: document.getElementById('root'),
    };
    
    if (!this.elements.root) {
      throw new Error('Root element not found');
    }
  }
  
  /**
   * Setup DOM event listeners
   */
  setupEventListeners() {
    // Will add after UI creation
  }
  
  /**
   * Setup IPC event listeners
   */
  setupIPCListeners() {
    // Listen for stream events
    if (window.aether.artifacts && window.aether.artifacts.onStream) {
      console.log('[ArtifactsApp] Setting up IPC stream listener');
      const streamCleanup = window.aether.artifacts.onStream((data) => {
        // NO per-chunk logging - handleArtifactStream does throttled logging
        this.handleArtifactStream(data);
      });
      this.cleanupFunctions.push(streamCleanup);
      console.log('[ArtifactsApp] IPC stream listener registered');
    } else {
      console.error('[ArtifactsApp] ❌ window.aether.artifacts.onStream not available!');
    }
    
    // Listen for tab switch requests (from trail node clicks)
    if (window.aether.artifacts && window.aether.artifacts.onSwitchTab) {
      console.log('[ArtifactsApp] Setting up tab switch listener');
      const tabCleanup = window.aether.artifacts.onSwitchTab((tab) => {
        console.log(`[ArtifactsApp] 📥 Received tab switch request: ${tab}`);
        this.switchTab(tab);
      });
      this.cleanupFunctions.push(tabCleanup);
      console.log('[ArtifactsApp] Tab switch listener registered');
    }
    
    // Listen for focus artifact requests (from trail node clicks)
    if (window.aether.artifacts && window.aether.artifacts.onFocus) {
      console.log('[ArtifactsApp] Setting up focus listener');
      const focusCleanup = window.aether.artifacts.onFocus((data) => {
        console.log(`[ArtifactsApp] 📥 Received focus request: artifact=${data.artifactId?.slice(0,8)}, tab=${data.tab}`);
        const artifactId = data.artifactId || data;
        const tab = data.tab;
        
        // Find and display the artifact
        const artifact = this.artifacts.find(a => a.id === artifactId);
        if (artifact) {
          console.log(`[ArtifactsApp] ✅ Found artifact, displaying...`);
          this.displayArtifact(artifact);
          if (tab) {
            this.switchTab(tab);
          }
        } else {
          console.warn(`[ArtifactsApp] ⚠️  Artifact not found: ${artifactId?.slice(0,8)}`);
          // Try to display from current state
          if (tab) {
            this.switchTab(tab);
          }
        }
      });
      this.cleanupFunctions.push(focusCleanup);
      console.log('[ArtifactsApp] Focus listener registered');
    }
  }
  
  /**
   * Initialize UI
   */
  initializeUI() {
    this.elements.root.innerHTML = `
      <div class="artifacts-window visible">
        <div class="artifacts-header">
          <div class="artifacts-tabs">
            <div class="artifacts-tab active" data-tab="code" id="tab-code">
              <span class="tab-label">Code</span>
            </div>
            <div class="artifacts-tab" data-tab="output" id="tab-output">
              <span class="tab-label">Output</span>
            </div>
            <div class="artifacts-tab" data-tab="files" id="tab-files">
              <span class="tab-label">Files</span>
            </div>
          </div>
          <div class="artifacts-controls">
            <button class="artifacts-control-btn" id="closeBtn" title="Close">×</button>
          </div>
        </div>
        
        <div class="artifacts-pane artifacts-code-pane active" id="codePane">
          <div class="artifacts-code-block">
            <pre id="codeEditor" class="code-display"></pre>
          </div>
        </div>
        
        <div class="artifacts-pane artifacts-output-pane" id="outputPane">
          <div class="artifacts-output-block">
            <div id="outputDisplay" class="output-display"></div>
          </div>
        </div>
        
        <div class="artifacts-pane artifacts-files-pane" id="filesPane">
          <div class="files-list" id="filesList">
            <div class="empty-state">No files yet</div>
          </div>
        </div>
      </div>
    `;
    
    // Cache new elements
    this.elements.codePane = document.getElementById('codePane');
    this.elements.outputPane = document.getElementById('outputPane');
    this.elements.filesPane = document.getElementById('filesPane');
    this.elements.codeEditor = document.getElementById('codeEditor');
    this.elements.outputDisplay = document.getElementById('outputDisplay');
    this.elements.filesList = document.getElementById('filesList');
    this.elements.closeBtn = document.getElementById('closeBtn');
    
    // Setup tab switching
    document.querySelectorAll('.artifacts-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchTab(tab.dataset.tab);
      });
    });
    
    // Setup close button
    if (this.elements.closeBtn) {
      this.elements.closeBtn.addEventListener('click', () => {
        if (window.aether.windowControl && window.aether.windowControl.control) {
          window.aether.windowControl.control('close');
        }
      });
    }
  }
  
  /**
   * Switch tab
   */
  switchTab(tabName) {
    this.currentTab = tabName;
    
    // Update tab buttons
    document.querySelectorAll('.artifacts-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Update panes
    document.querySelectorAll('.artifacts-pane').forEach(pane => {
      pane.classList.remove('active');
    });
    
    // Show active pane
    const paneId = `${tabName}Pane`;
    const activePane = document.getElementById(paneId);
    if (activePane) {
      activePane.classList.add('active');
    }
  }
  
  /**
   * Handle artifact stream
   * Properly accumulates streaming content using start/content/end protocol
   * Uses throttled logging to prevent console spam
   */
  handleArtifactStream(data) {
    // Extract metadata
    const artifactId = data.id || data._backend_id || `artifact_${Date.now()}`;
    const kind = data.kind || data.type;
    const format = data.format || data.language || 'text';
    const role = data.role || 'assistant';
    const content = data.content || '';
    
    // Track chat/message context
    if (data.chatId) {
      this.currentChatId = data.chatId;
    }
    if (data.messageId) {
      this.currentMessageId = data.messageId;
    }
    
    // Handle stream lifecycle
    if (data.start === true) {
      // ALWAYS log stream start
      console.log(`[ArtifactsApp] 🚀 Stream started: ${kind}/${format} (ID: ${artifactId.slice(0,8)}...)`);
      this.activeStreams.set(artifactId, {
        id: artifactId,
        type: kind,
        role: role,
        format: format,
        content: '',
        chatId: this.currentChatId,
        messageId: this.currentMessageId,
        startTime: Date.now(),
        chunkCount: 0
      });
      this._logThrottle.chunkCount = 0;
      return;
    }
    
    // Get or create accumulator
    let stream = this.activeStreams.get(artifactId);
    if (!stream) {
      // Create implicit stream if we receive content without start
      console.warn(`[ArtifactsApp] ⚠️  Received content without start marker: ${kind}/${format}`);
      stream = {
        id: artifactId,
        type: kind,
        role: role,
        format: format,
        content: '',
        chatId: this.currentChatId,
        messageId: this.currentMessageId,
        startTime: Date.now(),
        chunkCount: 0
      };
      this.activeStreams.set(artifactId, stream);
    }
    
    // Accumulate content
    if (content) {
      stream.content += content;
      stream.chunkCount++;
      this._logThrottle.chunkCount++;
      
      // Throttled progress logging - only log once per second
      const now = Date.now();
      if (now - this._logThrottle.lastLog > this._logThrottle.interval) {
        console.log(`[ArtifactsApp] 📝 Streaming: ${stream.chunkCount} chunks, ${stream.content.length} chars total`);
        this._logThrottle.lastLog = now;
      }
      
      // Update display in real-time for better UX
      this._updateStreamDisplay(stream);
    }
    
    // Handle stream end
    if (data.end === true) {
      // ALWAYS log stream end
      const duration = Date.now() - stream.startTime;
      console.log(`[ArtifactsApp] ✅ Stream complete: ${stream.chunkCount} chunks, ${stream.content.length} chars (${duration}ms)`);
      
      // Finalize artifact
      this._finalizeArtifact(stream);
      
      // Clean up accumulator
      this.activeStreams.delete(artifactId);
    }
  }
  
  /**
   * Update display with streaming content (real-time)
   * CRITICAL: Routes artifacts based on role, type, and format
   * - Assistant code → CODE tab (syntax highlighted)
   * - Computer console → OUTPUT tab (execution logs)
   * - Computer HTML → OUTPUT tab (rendered HTML)
   * @private
   */
  _updateStreamDisplay(stream) {
    console.log(`[ArtifactsApp] 📊 Updating display: role=${stream.role}, type=${stream.type}, format=${stream.format}, contentLength=${stream.content.length}`);
    
    // Determine target: CODE or OUTPUT
    const shouldShowInOutput = (
      // Console/output artifacts always go to output
      stream.type === 'console' ||
      stream.type === 'output' ||
      // Computer-generated HTML goes to output for rendering
      (stream.role === 'computer' && stream.format === 'html') ||
      // Computer-generated code also goes to output (execution results)
      (stream.role === 'computer' && stream.type === 'code')
    );
    
    if (shouldShowInOutput) {
      // Update output display
      console.log(`[ArtifactsApp] 📤 Updating OUTPUT display with ${stream.content.length} chars (format: ${stream.format})`);
      this.currentOutput = stream.content;
      this.currentOutputFormat = stream.format; // Track format for rendering
      this.updateOutputDisplay();
      
      // Switch to output tab if not already there
      if (this.currentTab !== 'output') {
        console.log(`[ArtifactsApp] 🔄 Switching to OUTPUT tab`);
        this.switchTab('output');
      }
    } else if (stream.type === 'code' || ['html', 'javascript', 'python', 'java', 'cpp', 'c', 'rust', 'go'].includes(stream.format)) {
      // Update code display (assistant-written code)
      console.log(`[ArtifactsApp] 📝 Updating CODE display (${stream.format})`);
      this.currentCode = stream.content;
      this.currentLanguage = stream.format;
      this.currentFilename = `stream.${stream.format}`;
      this.updateCodeDisplay();
      
      // Switch to code tab if not already there
      if (this.currentTab !== 'code') {
        console.log(`[ArtifactsApp] 🔄 Switching to CODE tab`);
        this.switchTab('code');
      }
    } else {
      console.warn(`[ArtifactsApp] ⚠️  Unknown artifact type: ${stream.type}/${stream.format} (role=${stream.role}) - defaulting to code display`);
      // Default to code display
      this.currentCode = stream.content;
      this.currentLanguage = stream.format || 'text';
      this.updateCodeDisplay();
    }
  }
  
  /**
   * Finalize artifact and add to artifacts registry
   * CRITICAL: Properly classifies artifacts based on role/type/format
   * @private
   */
  _finalizeArtifact(stream) {
    // Determine artifact type based on role, type, and format
    const isOutputArtifact = (
      stream.type === 'console' ||
      stream.type === 'output' ||
      (stream.role === 'computer' && stream.format === 'html') ||
      (stream.role === 'computer' && stream.type === 'code')
    );
    
    const artifact = {
      id: stream.id,
      type: isOutputArtifact ? 'output' : 'code',
      content: stream.content,
      language: stream.format,
      format: stream.format, // Preserve format for rendering
      filename: `artifact_${this.artifacts.length + 1}.${stream.format}`,
      chatId: stream.chatId,
      messageId: stream.messageId,
      role: stream.role,
      timestamp: Date.now(),
      duration: Date.now() - stream.startTime
    };
    
    console.log('[ArtifactsApp] 💾 Finalized artifact:', {
      id: artifact.id,
      type: artifact.type,
      format: artifact.format,
      role: artifact.role,
      contentLength: artifact.content.length,
      duration: artifact.duration
    });
    
    // Add to artifacts registry
    this.artifacts.push(artifact);
    this.currentArtifactIndex = this.artifacts.length - 1;
    
    // Display finalized artifact
    this.displayArtifact(artifact);
  }
  
  /**
   * Display artifact
   * Preserves format information for proper rendering
   */
  displayArtifact(artifact) {
    if (artifact.type === 'code') {
      this.currentCode = artifact.content || artifact.code || '';
      this.currentLanguage = artifact.language || artifact.format || 'text';
      this.currentFilename = artifact.filename || 'untitled';
      this.updateCodeDisplay();
      this.switchTab('code');
    } else if (artifact.type === 'output') {
      this.currentOutput = artifact.content || artifact.output || '';
      this.currentOutputFormat = artifact.format || artifact.language || 'text';
      this.updateOutputDisplay();
      this.switchTab('output');
    }
  }
  
  
  /**
   * Update code display
   */
  updateCodeDisplay() {
    if (this.elements.codeEditor) {
      this.elements.codeEditor.textContent = this.currentCode;
      
      // Apply syntax highlighting if available
      if (window.hljs && this.currentLanguage) {
        try {
          const highlighted = window.hljs.highlight(this.currentCode, { 
            language: this.currentLanguage,
            ignoreIllegals: true
          });
          this.elements.codeEditor.innerHTML = highlighted.value;
        } catch (error) {
          console.warn('Syntax highlighting failed:', error);
          // Keep plain text on failure
        }
      }
    }
  }
  
  /**
   * Update output display
   * Handles HTML, JSON, and plain text outputs
   */
  updateOutputDisplay() {
    if (!this.elements.outputDisplay) {
      console.warn('[ArtifactsApp] Output display element not found');
      return;
    }

    console.log(`[ArtifactsApp] 📊 Updating output display with ${this.currentOutput.length} chars`);
    
    // Clear existing content
    this.elements.outputDisplay.innerHTML = '';
    
    if (!this.currentOutput || this.currentOutput.trim() === '') {
      this.elements.outputDisplay.innerHTML = '<div style="padding: 20px; color: rgba(255,255,255,0.5);">No output to display</div>';
      return;
    }
    
    // Detect content type and render appropriately
    const trimmed = this.currentOutput.trim();
    
    // Check if it's HTML (starts with < and contains tags) or format is 'html'
    if ((trimmed.startsWith('<') && (trimmed.includes('</') || trimmed.includes('/>'))) || 
        this.currentOutputFormat === 'html') {
      console.log('[ArtifactsApp] Rendering as HTML in sandboxed iframe');
      try {
        // Create sandboxed iframe for safe HTML rendering
        const iframe = document.createElement('iframe');
        iframe.className = 'html-output-iframe';
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
        iframe.style.cssText = 'width: 100%; height: 100%; min-height: 400px; border: none; background: white; border-radius: 8px;';
        
        // Wrap HTML in complete document if not already
        let htmlDoc = this.currentOutput;
        if (!htmlDoc.includes('<!DOCTYPE') && !htmlDoc.includes('<html')) {
          htmlDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
    }
    * { box-sizing: border-box; }
  </style>
</head>
<body>
${htmlDoc}
</body>
</html>`;
        }
        
        // Append iframe and write content
        this.elements.outputDisplay.appendChild(iframe);
        
        iframe.onload = () => {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            doc.open();
            doc.write(htmlDoc);
            doc.close();
            console.log('[ArtifactsApp] ✅ HTML rendered successfully in iframe');
          } catch (error) {
            console.error('[ArtifactsApp] Failed to write to iframe:', error);
          }
        };
      } catch (error) {
        console.error('[ArtifactsApp] HTML rendering failed:', error);
        this.elements.outputDisplay.textContent = this.currentOutput;
      }
    }
    // Check if it's JSON
    else if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
             (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      console.log('[ArtifactsApp] Rendering as JSON');
      try {
        const parsed = JSON.parse(this.currentOutput);
        const formatted = JSON.stringify(parsed, null, 2);
        const pre = document.createElement('pre');
        pre.style.cssText = 'margin: 0; padding: 20px; font-family: monospace; font-size: 13px; line-height: 1.6; color: #e0e0e0; background: rgba(0,0,0,0.3); border-radius: 8px; overflow: auto;';
        pre.textContent = formatted;
        this.elements.outputDisplay.appendChild(pre);
        console.log('[ArtifactsApp] ✅ JSON rendered successfully');
      } catch (error) {
        console.warn('[ArtifactsApp] JSON parsing failed, rendering as text');
        this.elements.outputDisplay.textContent = this.currentOutput;
      }
    }
    // Plain text
    else {
      console.log('[ArtifactsApp] Rendering as plain text');
      const pre = document.createElement('pre');
      pre.style.cssText = 'margin: 0; padding: 20px; font-family: monospace; font-size: 13px; line-height: 1.6; color: #e0e0e0; white-space: pre-wrap; word-wrap: break-word;';
      pre.textContent = this.currentOutput;
      this.elements.outputDisplay.appendChild(pre);
    }
  }
  
  /**
   * Clear output
   */
  clearOutput() {
    this.currentOutput = '';
    this.updateOutputDisplay();
  }
  
  
  /**
   * Show error
   */
  showError(message) {
    if (this.elements.root) {
      this.elements.root.innerHTML = `
        <div style="padding: 40px; text-align: center;">
          <h2 style="color: #ff4444;">Error</h2>
          <p>${message}</p>
        </div>
      `;
    }
  }
  
  /**
   * Cleanup
   */
  cleanup() {
    console.log('🧹 Cleaning up artifacts application...');
    
    for (const cleanup of this.cleanupFunctions) {
      try {
        cleanup();
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }
    
    this.cleanupFunctions = [];
  }
}

// ============================================================================
// Application Entry Point
// ============================================================================

let app = null;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

function initializeApp() {
  try {
    app = new ArtifactsApp();
    app.initialize();
    
    // Expose for debugging
    window.__artifactsApp = app;
  } catch (error) {
    console.error('❌ Fatal error:', error);
  }
}

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  if (app) {
    app.cleanup();
  }
});

console.log('✅ Artifacts renderer script loaded');
