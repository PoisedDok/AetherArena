'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const { getAether } = require('../../../shared/bridge/AetherBridge');

const fileManagerLogger = createRendererLogger('ChatFileManager');

/**
 * @.architecture
 * 
 * Incoming: ChatWindow (file input), User file selections (File[]) --- {dom_event, File[]}
 * Processing: Validate size/type, read as text/base64, upload ALL as artifacts (backend sets routing) --- {5 jobs: JOB_VALIDATE, JOB_READ_FILE, JOB_UPLOAD_ARTIFACT, JOB_EMIT_EVENT, JOB_UPDATE_UI}
 * Outgoing: Backend /v1/storage/artifact/* (all files), EventBus (FILES.SENT_ARTIFACT/ERROR) --- {artifact_payload, json}
 * 
 * 
 * @module renderer/chat/modules/files/FileManager
 * 
 * FileManager - Chat File Attachment Handler
 * ============================================================================
 * Production-ready file attachment manager with:
 * - Multi-file queue management
 * - Image preview with base64 encoding
 * - Unified artifact upload (backend handles routing)
 * - Secure file validation
 * - Memory-efficient handling
 * 
 * Responsibilities:
 * - Handle file input events
 * - Manage file queue (add, remove, clear)
 * - Generate image previews
 * - Validate file types and sizes
 * - Upload all files as artifacts (backend decides routing)
 * - Coordinate with MessageManager for sending
 * 
 * Architecture:
 * - Event-driven with EventBus
 * - Integrates with DI container
 * - Secure file validation
 * - Clean separation of concerns
 * - Backend is single source of truth for routing decisions
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
    this.ipc = options.ipc || null;
    this.endpoint = options.endpoint || null;
    this.aether = options.aether || getAether();

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
    this.attachedImageFile = null; // Store the original File object for processing
    this.totalQueueSize = 0;

    // Event listeners tracking
    this._domListeners = [];
    this.log = fileManagerLogger.child({ scope: 'instance' });

    this.log.debug('FileManager constructed');
  }

  /**
   * Initialize file manager
   * Connects DOM elements and sets up event listeners
   */
  async init() {
    this.log.info('Initializing file manager');

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

      // File preview container ready for dynamic card rendering

      // Setup event listeners
      this._setupEventListeners();

      this.log.debug('FileManager initialized');
    } catch (error) {
      this.log.error('FileManager initialization failed', { error });
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

    this.log.trace('FileManager DOM event listeners registered');
  }

  /**
   * Handle file selection from input
   * @private
   */
  async _handleFileSelect(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    this.log.info('Files selected for upload', { count: files.length });

    // Validate and add files to queue
    for (const file of files) {
      try {
        await this._addFileToQueue(file);
      } catch (error) {
        this.log.error('Failed to add file to queue', { file: file.name, error });
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

    // If image, handle separately (don't add to file queue, use dedicated image preview)
    if (this._isImage(file)) {
      await this._generateImagePreview(file);
      return; // Don't add images to fileQueue - they have their own preview system
    }

    // Check total size (only for non-image files)
    if (this.totalQueueSize + file.size > MAX_TOTAL_SIZE) {
      throw new Error(`Total file size exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB limit`);
    }

    // Add to queue (non-image files only)
    this.fileQueue.push(file);
    this.totalQueueSize += file.size;
    this.log.debug('File added to queue', {
      file: file.name,
      size: this._formatSize(file.size)
    });
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
      this.attachedImageFile = file; // Store File object for later processing

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

      this.log.trace('Generated preview for file', { file: file.name });
    } catch (error) {
      this.log.error('Failed to generate preview', { file: file.name, error });
    }
  }
  /**
   * Remove file from queue by index (used by premium card UI)
   */
  removeFile(index) {
    
    if (index < 0 || index >= this.fileQueue.length) return;

    const file = this.fileQueue[index];
    this.fileQueue.splice(index, 1);
    this.totalQueueSize -= file.size;

    this.log.debug('Removed file from queue', { file: file.name, index });

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

    this.log.info('All files removed from queue');

    if (this.eventBus) {
      this.eventBus.emit(EventTypes.FILES.CLEARED);
    }
  }

  /**
   * Clear attached image
   */
  clearAttachedImage() {
    this.attachedImageBase64 = null;
    this.attachedImageFile = null; // Clear File object too

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

    this.log.trace('Image preview cleared');

    if (this.eventBus) {
      this.eventBus.emit(EventTypes.FILES.IMAGE_CLEARED);
    }
  }
  /**
   * Get premium file type icon
   * @private
   */
  _getFileIcon(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    const iconMap = {
      // Images
      'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'webp': '🖼️', 'svg': '🖼️',
      // Documents
      'pdf': '📕', 'doc': '📘', 'docx': '📘', 'txt': '📄', 'md': '📝',
      // Code
      'js': '📜', 'ts': '📜', 'jsx': '📜', 'tsx': '📜', 'py': '🐍', 'java': '☕',
      'cpp': '⚙️', 'c': '⚙️', 'html': '🌐', 'css': '🎨', 'json': '📋',
      // Archives
      'zip': '📦', 'rar': '📦', 'tar': '📦', 'gz': '📦',
      // Spreadsheets
      'xls': '📊', 'xlsx': '📊', 'csv': '📊',
      // Presentations
      'ppt': '📊', 'pptx': '📊',
      // Others
      'mp3': '🎵', 'wav': '🎵', 'mp4': '🎬', 'avi': '🎬'
    };
    return iconMap[ext] || '📎';
  }

  /**
   * Update preview UI with premium file cards
   * @private
   */
  _updatePreviewUI() {
    
    if (!this.filePreviewContainer) return;

    if (this.fileQueue.length > 0) {
      this.filePreviewContainer.style.display = 'flex';
      
      // Build premium file cards HTML
      const cardsHTML = this.fileQueue.map((file, index) => {
        const icon = this._getFileIcon(file.name);
        const size = this._formatSize(file.size);
        const nameEscaped = this._escapeHTML(file.name);
        
        return `
          <div class="file-preview-card" data-file-index="${index}">
            <button class="file-preview-remove" data-file-index="${index}" title="Remove file">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
            <div class="file-preview-icon">${icon}</div>
            <div class="file-preview-info">
              <div class="file-preview-name" title="${nameEscaped}">${nameEscaped}</div>
              <div class="file-preview-size">${size}</div>
            </div>
          </div>
        `;
      }).join('');
      
      this.filePreviewContainer.innerHTML = cardsHTML;
      
      // Add remove button listeners
      const removeButtons = this.filePreviewContainer.querySelectorAll('.file-preview-remove');
      removeButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const index = parseInt(btn.dataset.fileIndex);
          this.removeFile(index);
        });
      });
    } else {
      this.filePreviewContainer.style.display = 'none';
      this.filePreviewContainer.innerHTML = '';
    }
  }

  /**
   * Escape HTML for safe rendering
   * @private
   */
  _escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Send all queued files
   * @param {string} text - Message text to accompany files
   * @param {string} chatId - Chat ID for artifact linkage
   * @param {string} messageId - Message UUID for artifact linkage (CRITICAL for persistence)
   */
  async sendFiles(text = '', chatId = null, messageId = null) {
    
    // Check if we have ANY attachments (files OR image)
    if (!this.fileQueue.length && !this.attachedImageFile) {
      this.log.warn('Send requested with empty queue and no image');
      return;
    }

    this.log.info('Sending attachments to backend', { 
      fileCount: this.fileQueue.length,
      hasImage: !!this.attachedImageFile,
      chatId: chatId?.substring(0, 8),
      messageId: messageId?.substring(0, 8) 
    });

    // CRITICAL: Copy queue AND image BEFORE clearing
    const filesToProcess = [...this.fileQueue];
    const imageToProcess = this.attachedImageFile;
    
    
    // Clear queue to prevent re-sending
    this.clearAll();

    // Process image first (if exists)
    if (imageToProcess) {
      try {
        this.log.debug('Processing image attachment', { file: imageToProcess.name });
        await this._processFile(imageToProcess, text, chatId, messageId);
      } catch (error) {
        this.log.error('Failed to process image', { file: imageToProcess.name, error });
        this._showError(`Failed to process ${imageToProcess.name}: ${error.message}`);
      }
    }

    // Process each file with message linkage
    for (const file of filesToProcess) {
      try {
        await this._processFile(file, text, chatId, messageId);
      } catch (error) {
        this.log.error('Failed to process file for sending', { file: file.name, error });
        this._showError(`Failed to process ${file.name}: ${error.message}`);
      }
    }

    this.log.info('All attachments sent');
  }

  /**
   * Process individual file - upload as artifact (backend handles routing)
   * @private
   */
  async _processFile(file, text, chatId, messageId) {
    const fileName = file.name.toLowerCase();
    const isJSON = fileName.endsWith('.json');
    
    // Special handling ONLY for chat summaries
    if (isJSON && fileName.includes('_summary.json')) {
      this.log.debug('Uploading chat summary as artifact', { file: fileName, messageId });
      await this._uploadAsArtifact(file, {
        type: 'file',
        is_chat_summary: true  // ONLY flag we set
      }, chatId, messageId);
      return;
    }
    
    // ALL other files: backend decides routing
    this.log.debug('Uploading file as artifact', { file: fileName, messageId });
    await this._uploadAsArtifact(file, {
      type: 'file'
      // NO requires_vision, requires_docling, subtype
      // Backend sets these automatically
    }, chatId, messageId);
  }

  /**
   * Upload file directly as artifact with optional processing flags
   * @private
   */
  async _uploadAsArtifact(file, options = {}, explicitChatId = null, messageId = null) {
    try {
      // Read file content (text or base64 for binary files)
      const isText = this._isTextFile(file);
      let content = isText 
        ? await this._readFileAsText(file)
        : await this._readFileAsBase64(file);
      
      // Strip data URI prefix from base64 for backend (expects pure base64 string)
      if (!isText) {
        content = this._stripDataURIPrefix(content);
      }
      
      // Get chat ID: explicit param takes priority, then fallback to controller
      const chatId = explicitChatId || (this.chatWindow?._getCurrentChatId && this.chatWindow._getCurrentChatId());
      
      if (!chatId) {
        throw new Error('No active chat ID');
      }
      
      // Detect file language/type
      const language = this._detectFileLanguage(file.name);
      
      // Create artifact payload with all required fields
      const artifactId = `file:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
      const payload = {
        type: options.type || 'file',
        filename: file.name,
        content: content,
        language: language,
        artifact_id: artifactId,
        message_id: null,  // Backend will link after message creation (matching trail/node pattern)
        metadata: {
          role: 'user',  // Required by normalizer
          original_name: file.name,
          size: file.size,
          mime_type: file.type,
          uploaded_at: new Date().toISOString(),
          is_binary: !isText,
          // ONLY for chat summaries:
          is_chat_summary: options.is_chat_summary || false,
          ...(messageId ? { correlation_id: messageId } : {})
          // Backend sets: requires_vision, requires_docling
        },
        // Not required for 'file' type artifacts (only for 'output' type)
        subgroup_id: null,
        node_id: null
      };
      
      // Upload to backend
      if (this.aether?.storage) {
        await this.aether.storage.saveArtifact(chatId, payload);
        
        this.log.info('Uploaded file as artifact', { 
          file: file.name,
          artifactId,
          chatId: chatId.substring(0, 8),
          messageId: messageId ? messageId.substring(0, 8) : 'none',
          linkedToMessage: !!messageId,
          isChatSummary: options.is_chat_summary || false
        });
        
        // Emit event
        if (this.eventBus) {
          this.eventBus.emit(EventTypes.FILES.SENT_ARTIFACT, {
            fileName: file.name,
            artifactId,
            uploaded: true
          });
        }
      } else {
        throw new Error('Storage API not available');
      }
    } catch (error) {
      this.log.error('Failed to upload file as artifact', { file: file?.name, error });
      throw error;
    }
  }
  
  /**
   * Check if file is text-based (not binary)
   * @private
   */
  _isTextFile(file) {
    const fileName = file.name.toLowerCase();
    const textExtensions = [
      '.txt', '.md', '.json', '.js', '.ts', '.py', '.java', '.cpp', '.c', '.cs',
      '.html', '.css', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.sh', '.bash', '.ps1', '.sql', '.r', '.rb', '.php', '.go', '.rs', '.swift'
    ];
    return textExtensions.some(ext => fileName.endsWith(ext)) || file.type?.startsWith('text/');
  }
  
  /**
   * Detect file language from filename
   * @private
   */
  _detectFileLanguage(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    const langMap = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'rb': 'ruby',
      'php': 'php',
      'swift': 'swift',
      'kt': 'kotlin',
      'html': 'html',
      'css': 'css',
      'json': 'json',
      'xml': 'xml',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'txt': 'text',
      'pdf': 'pdf',
      'doc': 'doc',
      'docx': 'docx'
    };
    return langMap[ext] || 'text';
  }
  
  
  /**
   * Read file as text
   * @private
   */
  _readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (e) => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
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
          // Return full data URI for display (browser needs data:image/png;base64,...)
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
   * Strip data URI prefix from base64 string for backend
   * @private
   */
  _stripDataURIPrefix(dataURI) {
    const match = dataURI.match(/^data:[^;]+;base64,(.+)$/);
    return match ? match[1] : dataURI;
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
    // Errors are emitted via EventBus and logged; Toast integration handled by EventBusBridge.
    this.log.error('FileManager error', { message });
  }

  /**
   * Clear all attachments (files + image)
   */
  clearAll() {
    
    this.removeAllFiles();
    this.clearAttachedImage();
    this.log.debug('All attachments cleared from UI');
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
    this.log.info('Disposing FileManager');

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

    this.log.debug('FileManager disposed');
  }
}

module.exports = FileManager;
