'use strict';

/**
 * @.architecture
 * 
 * Incoming: ChatWindow (file input element, DOM references), User file selections (File objects from <input type="file">) --- {dom_types.file_input_event, Event | File[]}
 * Processing: Validate file type/size (max 10MB images, 50MB files, 100MB total), generate base64 preview for images, maintain fileQueue array, detect vision capability from backend, route images to vision model or Docling OCR, route documents to Docling via IPC --- {7 jobs: JOB_VALIDATE_SCHEMA, JOB_LOAD_FROM_DB, JOB_GENERATE_SESSION_ID, JOB_UPDATE_STATE, JOB_HTTP_REQUEST, JOB_SEND_IPC, JOB_EMIT_EVENT}
 * Outgoing: Endpoint.sendUserMessageWithImage() → Backend vision model, IpcBridge.invoke('docling:process-file') → Main Process → Docling service, EventBus (FILES.SELECTED/REMOVED/CLEARED/SENT_VISION/SENT_DOCLING/ERROR) --- {user_message_with_image | ipc_message, json}
 * 
 * 
 * @module renderer/chat/modules/files/FileManager
 * 
 * FileManager - Chat File Attachment Handler
 * ============================================================================
 * Production-ready file attachment manager with:
 * - Multi-file queue management
 * - Image preview with base64 encoding
 * - Vision model detection and routing
 * - Docling integration for document processing
 * - Secure file validation
 * - Memory-efficient handling
 * 
 * Responsibilities:
 * - Handle file input events
 * - Manage file queue (add, remove, clear)
 * - Generate image previews
 * - Validate file types and sizes
 * - Route vision-capable images to vision models
 * - Route documents to Docling service
 * - Coordinate with MessageManager for sending
 * 
 * Architecture:
 * - Event-driven with EventBus
 * - Integrates with DI container
 * - Secure file validation
 * - Clean separation of concerns
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { freeze } = Object;

// File type constants
const IMAGE_EXTENSIONS = freeze(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg', '.ico']);
const SUPPORTED_EXTENSIONS = freeze([
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg', '.ico',
  // Documents
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.ods', '.odp', '.rtf',
  // Text
  '.txt', '.md', '.html', '.xml', '.csv', '.tsv', '.json', '.yaml', '.yml',
  // Code
  '.js', '.ts', '.py', '.java', '.cpp', '.c', '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt'
]);

// File size limits
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB total

class FileManager {
  constructor(options = {}) {
    // Dependencies
    this.chatWindow = options.chatWindow || null;
    this.eventBus = options.eventBus || null;
    this.ipcBridge = options.ipcBridge || null;
    this.endpoint = options.endpoint || null;

    // DOM references (populated on init)
    this.fileInput = null;
    this.imagePreview = null;
    this.clearImageBtn = null;
    this.imagePreviewContainer = null;
    this.filePreviewContainer = null;
    this.previewHeader = null;
    this.fileList = null;
    this.fileNameSpan = null;
    this.clearFileBtn = null;

    // State
    this.fileQueue = []; // Array of File objects
    this.attachedImageBase64 = null;
    this.totalQueueSize = 0;

    // Event listeners tracking
    this._domListeners = [];

    console.log('[FileManager] Constructed');
  }

  /**
   * Initialize file manager
   * Connects DOM elements and sets up event listeners
   */
  async init() {
    console.log('[FileManager] Initializing...');

    try {
      // Get DOM elements from ChatWindow
      if (!this.chatWindow) {
        throw new Error('ChatWindow required for initialization');
      }

      const elements = this.chatWindow.getElements();
      this.fileInput = elements.fileInput;
      this.imagePreview = elements.imagePreview;
      this.clearImageBtn = elements.clearImageBtn;
      this.imagePreviewContainer = elements.imagePreviewContainer;
      this.filePreviewContainer = elements.filePreviewContainer;

      if (!this.fileInput) {
        throw new Error('File input element not found');
      }

      // Get child elements from preview containers
      if (this.filePreviewContainer) {
        this.previewHeader = this.filePreviewContainer.querySelector('.preview-header');
        this.fileList = this.filePreviewContainer.querySelector('.file-list');
        this.fileNameSpan = this.filePreviewContainer.querySelector('.file-name');
        this.clearFileBtn = this.filePreviewContainer.querySelector('.clear-file-btn');
      }

      // Setup event listeners
      this._setupEventListeners();

      console.log('[FileManager] ✅ Initialized');
    } catch (error) {
      console.error('[FileManager] ❌ Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Setup DOM event listeners
   * @private
   */
  _setupEventListeners() {
    // File input change
    if (this.fileInput) {
      const handler = (e) => this._handleFileSelect(e);
      this.fileInput.addEventListener('change', handler);
      this._domListeners.push({ element: this.fileInput, event: 'change', handler });
    }

    // Clear image button
    if (this.clearImageBtn) {
      const handler = () => this.clearAttachedImage();
      this.clearImageBtn.addEventListener('click', handler);
      this._domListeners.push({ element: this.clearImageBtn, event: 'click', handler });
    }

    // Clear all files button
    if (this.clearFileBtn) {
      const handler = () => this.removeAllFiles();
      this.clearFileBtn.addEventListener('click', handler);
      this._domListeners.push({ element: this.clearFileBtn, event: 'click', handler });
    }

    // File list toggle
    if (this.previewHeader) {
      const handler = () => this._toggleFileList();
      this.previewHeader.addEventListener('click', handler);
      this._domListeners.push({ element: this.previewHeader, event: 'click', handler });
    }

    console.log('[FileManager] Event listeners setup complete');
  }

  /**
   * Handle file selection from input
   * @private
   */
  async _handleFileSelect(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    console.log(`[FileManager] Selected ${files.length} file(s)`);

    // Validate and add files to queue
    for (const file of files) {
      try {
        await this._addFileToQueue(file);
      } catch (error) {
        console.error(`[FileManager] Failed to add file ${file.name}:`, error);
        this._showError(`Failed to add ${file.name}: ${error.message}`);
      }
    }

    // Clear input value to allow re-selecting same file
    event.target.value = '';

    // Update UI
    this._updatePreviewUI();

    // Emit event
    if (this.eventBus) {
      this.eventBus.emit(EventTypes.FILES.SELECTED, {
        count: this.fileQueue.length,
        totalSize: this.totalQueueSize
      });
    }
  }

  /**
   * Add file to queue with validation
   * @private
   */
  async _addFileToQueue(file) {
    // Validate file
    this._validateFile(file);

    // Check total size
    if (this.totalQueueSize + file.size > MAX_TOTAL_SIZE) {
      throw new Error(`Total file size exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB limit`);
    }

    // Add to queue
    this.fileQueue.push(file);
    this.totalQueueSize += file.size;

    console.log(`[FileManager] Added ${file.name} (${this._formatSize(file.size)})`);

    // If image, generate preview
    if (this._isImage(file)) {
      await this._generateImagePreview(file);
    }

    // Add to UI list
    this._addFileToUIList(file);
  }

  /**
   * Validate file type and size
   * @private
   */
  _validateFile(file) {
    if (!file || !file.name) {
      throw new Error('Invalid file object');
    }

    // Check file extension
    const ext = this._getFileExtension(file.name);
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    // Check file size
    const maxSize = this._isImage(file) ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
    if (file.size > maxSize) {
      throw new Error(`File size exceeds ${maxSize / 1024 / 1024}MB limit`);
    }

    // Check if duplicate
    if (this.fileQueue.some(f => f.name === file.name && f.size === file.size)) {
      throw new Error('File already in queue');
    }
  }

  /**
   * Generate image preview
   * @private
   */
  async _generateImagePreview(file) {
    try {
      const base64 = await this._readFileAsBase64(file);
      this.attachedImageBase64 = base64;

      if (this.imagePreview) {
        this.imagePreview.src = base64;
      }

      if (this.imagePreviewContainer) {
        this.imagePreviewContainer.style.display = 'block';
      }

      // Update input placeholder
      const inputElement = this.chatWindow?.getElements()?.input;
      if (inputElement) {
        inputElement.placeholder = 'Image attached – add a prompt and press send...';
      }

      console.log(`[FileManager] Generated preview for ${file.name}`);
    } catch (error) {
      console.error(`[FileManager] Failed to generate preview for ${file.name}:`, error);
    }
  }

  /**
   * Add file to UI list
   * @private
   */
  _addFileToUIList(file) {
    if (!this.fileList) return;

    const li = document.createElement('li');
    li.style.display = 'flex';
    li.style.alignItems = 'center';
    li.style.gap = '8px';
    li.style.padding = '4px 0';
    li.style.color = 'rgba(255, 255, 255, 0.9)';
    li.style.fontSize = '12px';

    const icon = this._isImage(file) ? '🖼️' : '📄';
    const sizeStr = this._formatSize(file.size);

    li.innerHTML = `
      <span style="flex:1">${icon} ${file.name} (${sizeStr})</span>
      <button class="file-remove-btn" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:14px;">×</button>
    `;

    const removeBtn = li.querySelector('.file-remove-btn');
    removeBtn.addEventListener('click', () => this._removeFile(file, li));

    this.fileList.appendChild(li);
  }

  /**
   * Remove file from queue
   * @private
   */
  _removeFile(file, listItem) {
    const index = this.fileQueue.indexOf(file);
    if (index === -1) return;

    this.fileQueue.splice(index, 1);
    this.totalQueueSize -= file.size;

    if (listItem && listItem.parentNode) {
      listItem.remove();
    }

    console.log(`[FileManager] Removed ${file.name}`);

    this._updatePreviewUI();

    if (this.eventBus) {
      this.eventBus.emit(EventTypes.FILES.REMOVED, {
        fileName: file.name,
        remaining: this.fileQueue.length
      });
    }
  }

  /**
   * Remove all files
   */
  removeAllFiles() {
    this.fileQueue = [];
    this.totalQueueSize = 0;

    if (this.fileList) {
      this.fileList.innerHTML = '';
    }

    this._updatePreviewUI();

    console.log('[FileManager] All files removed');

    if (this.eventBus) {
      this.eventBus.emit(EventTypes.FILES.CLEARED);
    }
  }

  /**
   * Clear attached image
   */
  clearAttachedImage() {
    this.attachedImageBase64 = null;

    if (this.imagePreview) {
      this.imagePreview.src = '';
    }

    if (this.imagePreviewContainer) {
      this.imagePreviewContainer.style.display = 'none';
    }

    if (this.fileInput) {
      this.fileInput.value = '';
    }

    // Reset input placeholder
    const inputElement = this.chatWindow?.getElements()?.input;
    if (inputElement) {
      inputElement.placeholder = 'Type a message or hold space to talk...';
    }

    console.log('[FileManager] Image preview cleared');

    if (this.eventBus) {
      this.eventBus.emit(EventTypes.FILES.IMAGE_CLEARED);
    }
  }

  /**
   * Toggle file list visibility
   * @private
   */
  _toggleFileList() {
    if (!this.fileList) return;

    const isHidden = this.fileList.style.display === 'none';
    this.fileList.style.display = isHidden ? 'block' : 'none';
  }

  /**
   * Update preview UI
   * @private
   */
  _updatePreviewUI() {
    if (!this.filePreviewContainer || !this.fileNameSpan) return;

    if (this.fileQueue.length > 0) {
      this.filePreviewContainer.style.display = 'block';
      const totalSize = this._formatSize(this.totalQueueSize);
      this.fileNameSpan.textContent = `${this.fileQueue.length} file(s) queued (${totalSize})`;
    } else {
      this.filePreviewContainer.style.display = 'none';
      this.fileNameSpan.textContent = '';
    }
  }

  /**
   * Send all queued files
   * @param {string} text - Message text to accompany files
   */
  async sendFiles(text = '') {
    if (!this.fileQueue.length) {
      console.log('[FileManager] No files to send');
      return;
    }

    console.log(`[FileManager] Sending ${this.fileQueue.length} file(s)...`);

    const filesToProcess = [...this.fileQueue];
    this.clearAll();

    // Process each file
    for (const file of filesToProcess) {
      try {
        await this._processFile(file, text);
      } catch (error) {
        console.error(`[FileManager] Failed to process ${file.name}:`, error);
        this._showError(`Failed to process ${file.name}: ${error.message}`);
      }
    }

    console.log('[FileManager] ✅ All files sent');
  }

  /**
   * Process individual file - route to vision or docling
   * @private
   */
  async _processFile(file, text) {
    const fileName = file.name.toLowerCase();
    const isImage = this._isImage(file);

    // Check if vision model is available and file is image
    if (isImage && this.endpoint) {
      const visionCapable = await this._checkVisionCapability();
      
      if (visionCapable) {
        console.log(`[FileManager] Routing ${fileName} to vision model`);
        await this._sendToVisionModel(file, text);
        return;
      } else {
        console.log(`[FileManager] Routing ${fileName} to Docling OCR`);
      }
    }

    // Route to Docling for document processing
    await this._sendToDocling(file, text);
  }

  /**
   * Check if current model supports vision
   * @private
   */
  async _checkVisionCapability() {
    if (!this.endpoint) return false;

    try {
      // Try to get current model from settings
      const llmModelInput = document.getElementById('llm-model');
      let modelName = llmModelInput?.value;

      // Fallback to health check
      if (!modelName) {
        const health = await this.endpoint.getHealth();
        modelName = health?.model;
      }

      if (!modelName) return false;

      // Check model capabilities
      const caps = await this.endpoint.getModelCapabilities(modelName);
      return caps && caps.supports_vision === true;
    } catch (error) {
      console.error('[FileManager] Vision capability check failed:', error);
      return false;
    }
  }

  /**
   * Send image to vision model
   * @private
   */
  async _sendToVisionModel(file, text) {
    try {
      const base64 = await this._readFileAsBase64(file);
      const imageData = base64.split(',')[1]; // Remove data URL prefix
      const requestId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      if (!this.endpoint.sendUserMessageWithImage) {
        throw new Error('Vision model method not available');
      }

      const messageText = text || 'Analyze this image';
      await this.endpoint.sendUserMessageWithImage(messageText, imageData, requestId);

      console.log(`[FileManager] ✅ Sent ${file.name} to vision model, requestId: ${requestId}`);

      if (this.eventBus) {
        this.eventBus.emit(EventTypes.FILES.SENT_VISION, {
          fileName: file.name,
          requestId
        });
      }
    } catch (error) {
      console.error(`[FileManager] Vision model send failed:`, error);
      throw error;
    }
  }

  /**
   * Send file to Docling service
   * @private
   */
  async _sendToDocling(file, text) {
    try {
      // Send via IPC to main process
      if (this.ipcBridge) {
        await this.ipcBridge.invoke('docling:process-file', {
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          filePath: file.path || null,
          message: text
        });

        console.log(`[FileManager] ✅ Sent ${file.name} to Docling`);

        if (this.eventBus) {
          this.eventBus.emit(EventTypes.FILES.SENT_DOCLING, {
            fileName: file.name
          });
        }
      } else {
        throw new Error('IPC bridge not available');
      }
    } catch (error) {
      console.error(`[FileManager] Docling send failed:`, error);
      throw error;
    }
  }

  /**
   * Read file as base64
   * @private
   */
  _readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      try {
        const reader = new FileReader();
        
        reader.onload = () => {
          const result = String(reader.result || '');
          resolve(result);
        };

        reader.onerror = () => {
          reject(new Error(`Failed to read file: ${file.name}`));
        };

        reader.readAsDataURL(file);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Check if file is image
   * @private
   */
  _isImage(file) {
    const ext = this._getFileExtension(file.name);
    return IMAGE_EXTENSIONS.includes(ext);
  }

  /**
   * Get file extension
   * @private
   */
  _getFileExtension(fileName) {
    const match = fileName.match(/\.[^.]+$/);
    return match ? match[0].toLowerCase() : '';
  }

  /**
   * Format file size for display
   * @private
   */
  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /**
   * Show error message
   * @private
   */
  _showError(message) {
    if (this.eventBus) {
      this.eventBus.emit(EventTypes.FILES.ERROR, { message });
    }
    // TODO: Integrate with UI notification system when available
    console.error(`[FileManager] ERROR: ${message}`);
  }

  /**
   * Clear all attachments (files + image)
   */
  clearAll() {
    this.removeAllFiles();
    this.clearAttachedImage();
    console.log('[FileManager] All attachments cleared');
  }

  /**
   * Get current state
   */
  getState() {
    return freeze({
      fileCount: this.fileQueue.length,
      totalSize: this.totalQueueSize,
      hasImage: !!this.attachedImageBase64,
      files: this.fileQueue.map(f => ({
        name: f.name,
        size: f.size,
        type: f.type
      }))
    });
  }

  /**
   * Get attached image base64
   */
  getAttachedImage() {
    return this.attachedImageBase64;
  }

  /**
   * Get file queue
   */
  getFileQueue() {
    return [...this.fileQueue];
  }

  /**
   * Check if has attachments
   */
  hasAttachments() {
    return this.fileQueue.length > 0 || !!this.attachedImageBase64;
  }

  /**
   * Cleanup and dispose
   */
  dispose() {
    console.log('[FileManager] Disposing...');

    // Remove event listeners
    for (const { element, event, handler } of this._domListeners) {
      element.removeEventListener(event, handler);
    }
    this._domListeners = [];

    // Clear state
    this.clearAll();

    // Clear references
    this.fileInput = null;
    this.imagePreview = null;
    this.clearImageBtn = null;
    this.imagePreviewContainer = null;
    this.filePreviewContainer = null;
    this.previewHeader = null;
    this.fileList = null;
    this.fileNameSpan = null;
    this.clearFileBtn = null;

    console.log('[FileManager] ✅ Disposed');
  }
}

module.exports = FileManager;

