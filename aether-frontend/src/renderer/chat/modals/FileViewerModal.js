'use strict';

/**
 * @.architecture
 * 
 * Incoming: EventBus (file:view-requested), artifact data --- {event.custom, artifact_object}
 * Processing: Display file content with syntax highlighting, format JSON/text/markdown/code --- {4 jobs: JOB_CREATE_DOM_ELEMENT, JOB_TRANSFORM_DATA, JOB_RENDER, JOB_VALIDATE_SCHEMA}
 * Outgoing: DOM (modal overlay with formatted content) --- {HTMLElement}
 * 
 * @.security innerHTML audit: SAFE
 * innerHTML usages build static modal structure (header, toolbar, empty states) and clear containers.
 * File content is rendered via textContent or syntax-highlighted through code formatting utilities.
 * Filenames displayed via textContent, not interpolated into HTML.
 * 
 * @module renderer/chat/modals/FileViewerModal
 */

const BaseModal = require('../../shared/modals/BaseModal');
const { createRendererLogger } = require('../../shared/utils/logger');

// PDF.js for robust PDF rendering
const pdfjsLib = require('pdfjs-dist');
// Set worker path to the bundled worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = require('pdfjs-dist/build/pdf.worker.min.js');

class FileViewerModal extends BaseModal {
  constructor(options = {}) {
    super({
      ...options,
      id: 'file-viewer-modal',
      maxWidth: '800px',
      showFooter: true  // Enable footer for PDF page nav + zoom controls
    });
    
    this.log = createRendererLogger('FileViewerModal');
    this.currentFile = null;
    
    // Lifecycle: track ALL listeners for cleanup (element-level + document-level)
    this._listeners = [];
  }

  async open(fileData) {
    
    if (!fileData) {
      this.log.warn('No file data provided');
      return;
    }
    
    // CRITICAL FIX: Re-create DOM if destroyed or never initialized
    if (!this.headerEl || !this.bodyEl || !this.overlay) {
      this.log.warn('Modal DOM not initialized, recreating');
      // Remove old overlay if it exists in DOM but references are null
      const oldOverlay = document.getElementById(`${this.id}-overlay`);
      if (oldOverlay && oldOverlay.parentNode) {
        oldOverlay.parentNode.removeChild(oldOverlay);
      }
      // Re-create DOM structure
      this._createElement();
      
      
      // CRITICAL: Verify DOM was created successfully
      if (!this.headerEl || !this.bodyEl || !this.overlay) {
        this.log.error('Failed to create modal DOM elements');
        return;
      }
    }
    
    this.currentFile = fileData;
    
    
    // CRITICAL FIX: await super.open() to ensure _renderContent() completes before proceeding
    await super.open();
    
  }

  close() {
    super.close();
  }

  _renderContent() {
    
    if (!this.currentFile) return;
    
    // CRITICAL FIX: Defensive null checks
    if (!this.headerEl || !this.bodyEl) {
      this.log.error('Modal DOM elements are null, cannot render');
      return;
    }
    
    const { filename, content, language, metadata } = this.currentFile;
    const chatSummaryData = this._parseChatSummary(content, filename);
    
    
    // Clear body
    this.bodyEl.innerHTML = '';
    
    
    // Header with filename and metadata
    this.headerEl.innerHTML = '';
    
    
    const headerContent = document.createElement('div');
    headerContent.className = 'cm-header-content';
    
    const titleSection = document.createElement('div');
    titleSection.className = 'cm-title-section';
    
    const title = document.createElement('div');
    title.textContent = chatSummaryData
      ? `Chat Summary: ${chatSummaryData.chat_title || 'Untitled Chat'}`
      : (filename || 'File Viewer');
    title.className = 'cm-title';
    
    const meta = document.createElement('div');
    meta.className = 'cm-meta';
    
    const metaParts = [];
    
    // Derive display type from language, mime_type, or filename
    let displayType = language;
    if (!displayType && metadata?.mime_type) {
      // Extract type from mime_type (e.g., "image/png" -> "PNG")
      const mimeMatch = metadata.mime_type.match(/^([^/]+)\/([^;]+)/);
      if (mimeMatch) {
        displayType = mimeMatch[2].toUpperCase(); // "png" -> "PNG"
      }
    }
    if (!displayType && filename) {
      const ext = filename.split('.').pop();
      if (ext && ext !== filename) {
        displayType = ext.toUpperCase();
      }
    }
    if (chatSummaryData) {
      // Show summary type + model in meta (title already says "Chat Summary")
      const summaryMeta = [];
      if (chatSummaryData.summary_type) summaryMeta.push(chatSummaryData.summary_type);
      if (chatSummaryData.summary_model) summaryMeta.push(chatSummaryData.summary_model);
      displayType = summaryMeta.length > 0 ? summaryMeta.join(' \u2022 ') : 'Chat Summary';
    }
    
    if (displayType) metaParts.push(displayType);
    if (metadata?.size) metaParts.push(this._formatFileSize(metadata.size));
    meta.textContent = metaParts.join(' • ');
    
    titleSection.appendChild(title);
    titleSection.appendChild(meta);
    
    // Check if this is an image file for zoom controls
    const isImage = this._isImageFile(filename);
    const isPDF = this._isPDFFile(filename, metadata);
    
    // Actions container (zoom + download + close)
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'cm-actions-container';
    
    // Zoom controls (only for images)
    if (isImage) {
      const zoomOutBtn = document.createElement('button');
      zoomOutBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
          <line x1="8" y1="11" x2="14" y2="11"></line>
        </svg>
      `;
      zoomOutBtn.title = 'Zoom Out (or scroll)';
      zoomOutBtn.setAttribute('aria-label', 'Zoom out');
      zoomOutBtn.className = 'cm-action-btn';
      this._trackListener(zoomOutBtn, 'click', () => this._adjustZoom(-0.2));
      
      const zoomResetBtn = document.createElement('button');
      zoomResetBtn.textContent = '100%';
      zoomResetBtn.title = 'Reset Zoom';
      zoomResetBtn.className = 'cm-action-btn cm-action-btn--zoom-reset';
      this._trackListener(zoomResetBtn, 'click', () => this._resetZoom());
      this.zoomResetBtn = zoomResetBtn;
      
      const zoomInBtn = document.createElement('button');
      zoomInBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
          <line x1="11" y1="8" x2="11" y2="14"></line>
          <line x1="8" y1="11" x2="14" y2="11"></line>
        </svg>
      `;
      zoomInBtn.title = 'Zoom In (or scroll)';
      zoomInBtn.className = 'cm-action-btn';
      this._trackListener(zoomInBtn, 'click', () => this._adjustZoom(0.2));
      
      actionsContainer.appendChild(zoomOutBtn);
      actionsContainer.appendChild(zoomResetBtn);
      actionsContainer.appendChild(zoomInBtn);
      
      // Divider
      const divider = document.createElement('div');
      divider.className = 'cm-divider';
      actionsContainer.appendChild(divider);
    }
    
    // Download button
    const downloadBtn = document.createElement('button');
    downloadBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
    `;
    downloadBtn.title = 'Download file';
    downloadBtn.setAttribute('aria-label', 'Download file');
    downloadBtn.className = 'cm-action-btn';
    this._trackListener(downloadBtn, 'click', () => this._downloadFile());
    
    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.className = 'cm-action-btn cm-action-btn--close';
    closeBtn.setAttribute('aria-label', 'Close file viewer');
    this._trackListener(closeBtn, 'click', () => this.close());
    
    actionsContainer.appendChild(downloadBtn);
    actionsContainer.appendChild(closeBtn);
    
    headerContent.appendChild(titleSection);
    headerContent.appendChild(actionsContainer);
    this.headerEl.appendChild(headerContent);
    
    // Content viewer
    const contentViewer = document.createElement('div');
    contentViewer.className = 'file-content-viewer';
    
    // Apply different styles for images vs text vs summary
    if (isImage) {
      contentViewer.classList.add('cm-content-viewer--image');
    } else if (isPDF) {
      contentViewer.classList.add('cm-content-viewer--pdf');
    } else if (chatSummaryData) {
      contentViewer.classList.add('cm-content-viewer--summary');
    } else {
      contentViewer.classList.add('cm-content-viewer--text');
    }
    
    if (isImage && content) {
      // Render image with base64 content and zoom/pan support
      const imgSrc = content.startsWith('data:') ? content : `data:image/png;base64,${content}`;
      
      const img = document.createElement('img');
      img.src = imgSrc;
      img.alt = filename;
      img.draggable = false;
      img.className = 'cm-viewer-image';
      
      // Initialize zoom state
      this.currentZoom = 1;
      this.currentX = 0;
      this.currentY = 0;
      this.isDragging = false;
      this.startX = 0;
      this.startY = 0;
      this.currentImg = img;
      
      // Mouse wheel zoom
      this._trackListener(contentViewer, 'wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        this._adjustZoom(delta);
      }, { passive: false });
      
      // Pan support
      this._trackListener(img, 'mousedown', (e) => {
        if (this.currentZoom > 1) {
          this.isDragging = true;
          this.startX = e.clientX - this.currentX;
          this.startY = e.clientY - this.currentY;
          img.style.cursor = 'grabbing';
        }
      });
      
      // LIFECYCLE: Track document-level listeners for cleanup on modal close
      const imgMoveHandler = (e) => {
        if (this.isDragging) {
          this.currentX = e.clientX - this.startX;
          this.currentY = e.clientY - this.startY;
          this._updateTransform();
        }
      };
      const imgUpHandler = () => {
        if (this.isDragging) {
          this.isDragging = false;
          if (this.currentImg) {
            this.currentImg.style.cursor = this.currentZoom > 1 ? 'grab' : 'grab';
          }
        }
      };
      this._trackListener(document, 'mousemove', imgMoveHandler);
      this._trackListener(document, 'mouseup', imgUpHandler);
      
      contentViewer.appendChild(img);
    } else if (isPDF && content) {
      
      // Render PDF using PDF.js to canvas
      this._renderPDF(content, contentViewer, filename).catch(err => {
        
        // Fallback UI - use programmatic DOM to avoid innerHTML XSS and inline onclick CSP issues
        contentViewer.innerHTML = '';
        const fallback = document.createElement('div');
        fallback.className = 'cm-pdf-fallback';
        const msg = document.createElement('div');
        msg.className = 'cm-pdf-fallback-msg';
        msg.textContent = `PDF rendering failed: ${err.message || 'Unknown error'}`;
        const dlBtn = document.createElement('button');
        dlBtn.textContent = 'Download Instead';
        dlBtn.className = 'cm-pdf-fallback-btn';
        this._trackListener(dlBtn, 'click', () => this._downloadFile());
        fallback.appendChild(msg);
        fallback.appendChild(dlBtn);
        contentViewer.appendChild(fallback);
      });
    } else if (chatSummaryData) {
      // Render structured chat summary card with toggle to raw JSON
      this._renderChatSummaryCard(chatSummaryData, contentViewer);
    } else {
      // Format text content based on type
      const formattedContent = this._formatContent(content, language || this._detectLanguage(filename));
      contentViewer.innerHTML = formattedContent;
    }
    
    this.bodyEl.appendChild(contentViewer);
    
    // Footer with actions (only if footer exists)
    if (this.footerEl) {
      this.footerEl.innerHTML = '';
      this.footerEl.style.display = 'flex';
      
      const footer = document.createElement('div');
      footer.className = 'cm-footer';
      
      const info = document.createElement('div');
      info.className = 'cm-footer-info';
      
      if (chatSummaryData) {
        // Summary-specific footer info
        const infoParts = ['Chat Summary'];
        if (chatSummaryData.summary_model) infoParts.push(chatSummaryData.summary_model);
        if (chatSummaryData.summary_created_at) {
          try {
            const d = new Date(chatSummaryData.summary_created_at);
            if (!isNaN(d.getTime())) infoParts.push(d.toLocaleDateString());
          } catch (e) { /* skip invalid date */ }
        }
        info.textContent = infoParts.join(' \u2022 ');
      } else {
        const lines = (content || '').split('\n').length;
        const chars = (content || '').length;
        info.textContent = `${lines} lines \u2022 ${chars} characters`;
      }
      
      const actionsContainer = document.createElement('div');
      actionsContainer.className = 'cm-footer-actions';
      
      // Toggle button (only for chat summaries — visually secondary to Copy)
      if (chatSummaryData) {
        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = 'View Raw JSON';
        toggleBtn.className = 'cm-toggle-btn';
        this._trackListener(toggleBtn, 'click', () => {
          if (!this._summaryViewEl || !this._rawViewEl) return;
          const showingRaw = this._rawViewEl.style.display !== 'none';
          this._summaryViewEl.style.display = showingRaw ? '' : 'none';
          this._rawViewEl.style.display = showingRaw ? 'none' : '';
          toggleBtn.textContent = showingRaw ? 'View Raw JSON' : 'View Summary';
          
          // Fade-in the newly visible view
          const shownEl = showingRaw ? this._summaryViewEl : this._rawViewEl;
          shownEl.classList.remove('cm-summary-fade-in');
          void shownEl.offsetWidth; // Force reflow to restart animation
          shownEl.classList.add('cm-summary-fade-in');
        });
        actionsContainer.appendChild(toggleBtn);
      }
      
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy';
      copyBtn.className = 'cm-copy-btn';
      
      this._trackListener(copyBtn, 'click', async () => {
        try {
          await navigator.clipboard.writeText(content);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 2000);
        } catch (error) {
          this.log.error('Failed to copy content', { error });
        }
      });
      
      actionsContainer.appendChild(copyBtn);
      
      footer.appendChild(info);
      footer.appendChild(actionsContainer);
      this.footerEl.appendChild(footer);
    }
  }

  _formatContent(content, language) {
    if (!content) return '<span style="color: var(--color-text-tertiary);">Empty file</span>';
    
    // Try to parse and pretty-print JSON
    if (language === 'json') {
      try {
        const parsed = JSON.parse(content);
        const pretty = JSON.stringify(parsed, null, 2);
        return this._highlightJSON(pretty);
      } catch (e) {
        // Not valid JSON, display as-is
      }
    }
    
    // Escape HTML
    const escaped = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
    
    return escaped;
  }

  _highlightJSON(jsonString) {
    // Simple JSON syntax highlighting
    return jsonString
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?)/g, (match) => {
        let cls = 'json-string';
        if (/:$/.test(match)) {
          cls = 'json-key';
        }
        return `<span style="color: ${this._getJSONColor(cls)}">${match}</span>`;
      })
      .replace(/\b(true|false|null)\b/g, '<span style="color: var(--color-warning)">$1</span>')
      .replace(/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, '<span style="color: var(--color-info)">$1</span>');
  }

  _getJSONColor(type) {
    switch (type) {
      case 'json-key':
        return 'var(--color-primary)';
      case 'json-string':
        return 'var(--color-success)';
      default:
        return 'var(--color-text-primary)';
    }
  }

  /**
   * Parse content as a chat summary JSON.
   * @private
   * @param {string} content - Raw file content
   * @param {string} filename - Filename for extension check
   * @returns {Object|null} Parsed chat summary object, or null if not a summary
   */
  _parseChatSummary(content, filename) {
    if (!content || typeof content !== 'string') return null;
    if (!filename || !filename.toLowerCase().endsWith('.json')) return null;
    try {
      const parsed = JSON.parse(content);
      return (parsed && parsed.type === 'chat_summary') ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Render a structured chat summary card with toggle to raw JSON.
   * Uses programmatic DOM construction (no innerHTML with user data) for security.
   * @private
   * @param {Object} data - Parsed chat summary object
   * @param {HTMLElement} containerEl - Container to render into
   */
  _renderChatSummaryCard(data, containerEl) {
    // === Structured Summary View ===
    const summaryView = document.createElement('div');
    summaryView.className = 'cm-summary-view';

    const card = document.createElement('div');
    card.className = 'csumm-card';

    // Title row with chat icon
    const headerRow = document.createElement('div');
    headerRow.className = 'cm-summary-header-row';

    const icon = document.createElement('div');
    icon.className = 'cm-summary-icon';
    icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

    const titleEl = document.createElement('h3');
    titleEl.className = 'csumm-card-title';
    titleEl.style.margin = '0';
    titleEl.textContent = data.chat_title || 'Untitled Chat';

    headerRow.appendChild(icon);
    headerRow.appendChild(titleEl);
    card.appendChild(headerRow);

    // Summary prose (pre-line preserves \n from LLM-generated summaries)
    if (data.summary) {
      const prose = document.createElement('p');
      prose.className = 'csumm-card-prose';
      prose.style.whiteSpace = 'pre-line';
      prose.textContent = data.summary;
      card.appendChild(prose);
    }

    // Key points
    if (Array.isArray(data.key_points) && data.key_points.length > 0) {
      const validPoints = data.key_points.filter(p => typeof p === 'string' && p.trim());
      if (validPoints.length > 0) {
        const pointsTitle = document.createElement('div');
        pointsTitle.className = 'csumm-points-title';
        pointsTitle.textContent = 'Key Points';
        card.appendChild(pointsTitle);

        const list = document.createElement('ul');
        list.className = 'csumm-points-list';
        for (const point of validPoints) {
          const item = document.createElement('li');
          item.className = 'csumm-points-item';
          item.textContent = point;
          list.appendChild(item);
        }
        card.appendChild(list);
      }
    }

    // Entity badges (grouped by category)
    if (data.entities && typeof data.entities === 'object') {
      const entityKeys = Object.keys(data.entities).filter(k => {
        const val = data.entities[k];
        return Array.isArray(val) ? val.length > 0 : Boolean(val);
      });

      if (entityKeys.length > 0) {
        for (const key of entityKeys) {
          const badgesRow = document.createElement('div');
          badgesRow.className = 'csumm-badges-container';

          const label = document.createElement('span');
          label.className = 'csumm-badge-label';
          label.textContent = key.charAt(0).toUpperCase() + key.slice(1) + ': ';
          badgesRow.appendChild(label);

          const values = Array.isArray(data.entities[key]) ? data.entities[key] : [data.entities[key]];
          for (const val of values) {
            if (val && typeof val === 'string') {
              const badge = document.createElement('span');
              badge.className = 'csumm-entity-badge';
              badge.textContent = val;
              badgesRow.appendChild(badge);
            }
          }
          card.appendChild(badgesRow);
        }
      }
    }

    // Metadata row
    const metaParts = [];
    if (data.summary_type) metaParts.push(`Type: ${data.summary_type}`);
    if (data.summary_model) metaParts.push(`Model: ${data.summary_model}`);
    if (data.summary_created_at) {
      try {
        const d = new Date(data.summary_created_at);
        if (!isNaN(d.getTime())) metaParts.push(`Created: ${d.toLocaleDateString()}`);
      } catch (e) { /* skip invalid date */ }
    }
    if (data.chat_created_at) {
      try {
        const d = new Date(data.chat_created_at);
        if (!isNaN(d.getTime())) metaParts.push(`Chat: ${d.toLocaleDateString()}`);
      } catch (e) { /* skip invalid date */ }
    }

    if (metaParts.length > 0) {
      const metaEl = document.createElement('div');
      metaEl.className = 'csumm-meta';
      metaEl.textContent = metaParts.join(' \u2022 ');
      card.appendChild(metaEl);
    }

    summaryView.appendChild(card);
    containerEl.appendChild(summaryView);

    // === Raw JSON View (hidden by default) ===
    const rawView = document.createElement('div');
    rawView.className = 'cm-summary-raw-view';
    rawView.style.display = 'none';
    rawView.innerHTML = this._highlightJSON(JSON.stringify(data, null, 2));
    containerEl.appendChild(rawView);

    // Store references for footer toggle button
    this._summaryViewEl = summaryView;
    this._rawViewEl = rawView;
  }

  _isImageFile(filename) {
    if (!filename) return false;
    const ext = filename.toLowerCase().split('.').pop();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
  }

  _isPDFFile(filename, metadata) {
    if (metadata?.mime_type === 'application/pdf') return true;
    if (!filename) return false;
    const ext = filename.toLowerCase().split('.').pop();
    return ext === 'pdf';
  }

  _detectLanguage(filename) {
    if (!filename) return 'text';
    
    const ext = filename.toLowerCase().split('.').pop();
    const langMap = {
      'json': 'json',
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'md': 'markdown',
      'txt': 'text',
      'html': 'html',
      'css': 'css',
      'xml': 'xml',
      'yaml': 'yaml',
      'yml': 'yaml'
    };
    
    return langMap[ext] || 'text';
  }

  _formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  
  /**
   * Download file
   * @private
   */
  _downloadFile() {
    if (!this.currentFile) {
      this.log.warn('No file to download');
      return;
    }
    
    const { filename, content } = this.currentFile;
    
    try {
      // Create blob from content
      const blob = new Blob([content], { type: 'application/octet-stream' });
      
      // Create download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'download.txt';
      document.body.appendChild(a);
      a.click();
      
      // Cleanup
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.log.info('File downloaded', { filename });
    } catch (error) {
      this.log.error('Failed to download file', { filename, error });
    }
  }

  _adjustZoom(delta) {
    if (!this.currentImg) return;
    
    // Clamp zoom between 0.5x and 5x
    this.currentZoom = Math.max(0.5, Math.min(5, this.currentZoom + delta));
    
    // Reset pan when zooming out to 1x or below
    if (this.currentZoom <= 1) {
      this.currentX = 0;
      this.currentY = 0;
      this.currentImg.style.cursor = 'grab';
    } else {
      this.currentImg.style.cursor = 'grab';
    }
    
    this._updateTransform();
    this._updateZoomDisplay();
  }

  _resetZoom() {
    if (!this.currentImg) return;
    
    this.currentZoom = 1;
    this.currentX = 0;
    this.currentY = 0;
    this.currentImg.style.cursor = 'grab';
    
    this._updateTransform();
    this._updateZoomDisplay();
  }

  _updateTransform() {
    if (!this.currentImg) return;
    
    this.currentImg.style.transform = `scale(${this.currentZoom}) translate(${this.currentX / this.currentZoom}px, ${this.currentY / this.currentZoom}px)`;
  }

  _updateZoomDisplay() {
    if (this.zoomResetBtn) {
      this.zoomResetBtn.textContent = `${Math.round(this.currentZoom * 100)}%`;
    }
  }

  async _renderPDF(base64Content, containerEl, filename) {
    
    try {
      // Strip data URI prefix if present
      const pureBase64 = base64Content.startsWith('data:') ? base64Content.split(',')[1] : base64Content;
      
      // Convert base64 to Uint8Array
      const binaryString = atob(pureBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      
      // Load PDF document
      const loadingTask = pdfjsLib.getDocument({ data: bytes });
      const pdf = await loadingTask.promise;
      
      
      // Initialize PDF zoom state
      this.pdfZoom = 1.0;
      this.pdfPages = [];
      
      // Create PDF viewer container (without nav bar)
      const pdfContainer = document.createElement('div');
      pdfContainer.className = 'pdf-viewer-container cm-pdf-container';
      
      // Render all pages with auto-fit to modal width
      const pages = [];
      const maxCanvasWidth = 740; // Modal max-width (800px) - padding
      
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        
        // Calculate scale to fit modal width
        const baseViewport = page.getViewport({ scale: 1.0 });
        const scale = Math.min(maxCanvasWidth / baseViewport.width, 2.0) * this.pdfZoom;
        const viewport = page.getViewport({ scale });
        
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.className = 'cm-pdf-canvas';
        canvas.dataset.pageNum = pageNum;
        
        const context = canvas.getContext('2d');
        const renderContext = {
          canvasContext: context,
          viewport: viewport
        };
        
        await page.render(renderContext).promise;
        pages.push({ canvas, page, baseViewport });
        this.pdfPages.push({ canvas, page, baseViewport });
        pdfContainer.appendChild(canvas);
        
      }
      
      containerEl.appendChild(pdfContainer);
      
      // Add pan support for zoomed PDFs (drag to scroll)
      let isPanning = false;
      let startX = 0;
      let startY = 0;
      let scrollLeft = 0;
      let scrollTop = 0;
      
      this._trackListener(pdfContainer, 'mousedown', (e) => {
        // Only pan if content is larger than container (zoomed)
        if (this.pdfZoom > 1.0) {
          isPanning = true;
          pdfContainer.style.cursor = 'grabbing';
          startX = e.pageX - pdfContainer.offsetLeft;
          startY = e.pageY - pdfContainer.offsetTop;
          scrollLeft = this.bodyEl.scrollLeft;
          scrollTop = this.bodyEl.scrollTop;
          e.preventDefault();
        }
      });
      
      // LIFECYCLE: Track document-level listeners for cleanup on modal close
      const pdfMoveHandler = (e) => {
        if (!isPanning) return;
        e.preventDefault();
        const x = e.pageX - pdfContainer.offsetLeft;
        const y = e.pageY - pdfContainer.offsetTop;
        const walkX = (x - startX) * 1.5; // Multiply for faster scrolling
        const walkY = (y - startY) * 1.5;
        this.bodyEl.scrollLeft = scrollLeft - walkX;
        this.bodyEl.scrollTop = scrollTop - walkY;
      };
      const pdfUpHandler = () => {
        if (isPanning) {
          isPanning = false;
          pdfContainer.style.cursor = this.pdfZoom > 1.0 ? 'grab' : 'default';
        }
      };
      this._trackListener(document, 'mousemove', pdfMoveHandler);
      this._trackListener(document, 'mouseup', pdfUpHandler);
      
      // Set initial cursor
      pdfContainer.style.cursor = this.pdfZoom > 1.0 ? 'grab' : 'default';
      
      
      // Create footer with page navigation and zoom controls
      if (this.footerEl) {
        
        this.footerEl.innerHTML = '';
        this.footerEl.style.display = 'flex';
        this.footerEl.style.justifyContent = 'space-between';
        this.footerEl.style.alignItems = 'center';
        this.footerEl.style.padding = 'var(--spacing-sm) var(--spacing-md)';
        
        // Page navigation
        const navContainer = document.createElement('div');
        navContainer.className = 'cm-pdf-nav';
        
        const prevBtn = document.createElement('button');
        prevBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        `;
        prevBtn.className = 'cm-nav-btn';
        prevBtn.setAttribute('aria-label', 'Previous page');
        
        const pageInfo = document.createElement('span');
        pageInfo.textContent = `Page 1 of ${pdf.numPages}`;
        pageInfo.className = 'cm-page-info';
        
        const nextBtn = document.createElement('button');
        nextBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        `;
        nextBtn.className = 'cm-nav-btn';
        nextBtn.setAttribute('aria-label', 'Next page');
        
        // Zoom controls
        const zoomContainer = document.createElement('div');
        zoomContainer.className = 'cm-pdf-zoom';
        
        const zoomOutBtn = document.createElement('button');
        zoomOutBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
            <line x1="8" y1="11" x2="14" y2="11"></line>
          </svg>
        `;
        zoomOutBtn.className = 'cm-nav-btn cm-nav-btn--icon';
        zoomOutBtn.setAttribute('aria-label', 'Zoom out PDF');
        
        const zoomLevel = document.createElement('span');
        zoomLevel.textContent = '100%';
        zoomLevel.className = 'cm-zoom-level';
        this.pdfZoomLevel = zoomLevel;
        
        const zoomInBtn = document.createElement('button');
        zoomInBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
            <line x1="11" y1="8" x2="11" y2="14"></line>
            <line x1="8" y1="11" x2="14" y2="11"></line>
          </svg>
        `;
        zoomInBtn.className = 'cm-nav-btn cm-nav-btn--icon';
        zoomInBtn.setAttribute('aria-label', 'Zoom in PDF');
        
        navContainer.appendChild(prevBtn);
        navContainer.appendChild(pageInfo);
        navContainer.appendChild(nextBtn);
        
        zoomContainer.appendChild(zoomOutBtn);
        zoomContainer.appendChild(zoomLevel);
        zoomContainer.appendChild(zoomInBtn);
        
        this.footerEl.appendChild(navContainer);
        this.footerEl.appendChild(zoomContainer);
        
        // Page navigation logic
        let currentPage = 1;
        const scrollToPage = (pageNum) => {
          const canvas = pdfContainer.querySelector(`canvas[data-page-num="${pageNum}"]`);
          if (canvas) {
            canvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
            currentPage = pageNum;
            pageInfo.textContent = `Page ${pageNum} of ${pdf.numPages}`;
          }
        };
        
        this._trackListener(prevBtn, 'click', () => {
          if (currentPage > 1) scrollToPage(currentPage - 1);
        });
        this._trackListener(nextBtn, 'click', () => {
          if (currentPage < pdf.numPages) scrollToPage(currentPage + 1);
        });
        
        // Zoom logic
        const rerenderPages = async () => {
          
          pdfContainer.innerHTML = '';
          this.pdfPages = [];
          
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const baseViewport = page.getViewport({ scale: 1.0 });
            
            // Calculate base scale to fit modal, then multiply by user zoom
            const baseFitScale = Math.min(maxCanvasWidth / baseViewport.width, 2.0);
            const scale = baseFitScale * this.pdfZoom;
            const viewport = page.getViewport({ scale });
            
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.className = 'cm-pdf-canvas';
            canvas.style.maxWidth = 'none';
            canvas.style.width = `${viewport.width}px`;
            canvas.dataset.pageNum = pageNum;
            
            const context = canvas.getContext('2d');
            await page.render({ canvasContext: context, viewport }).promise;
            
            this.pdfPages.push({ canvas, page, baseViewport });
            pdfContainer.appendChild(canvas);
          }
          
          zoomLevel.textContent = `${Math.round(this.pdfZoom * 100)}%`;
          
          // Update cursor based on zoom level
          pdfContainer.style.cursor = this.pdfZoom > 1.0 ? 'grab' : 'default';
          
        };
        
        this._trackListener(zoomOutBtn, 'click', async () => {
          
          if (this.pdfZoom > 0.5) {
            this.pdfZoom = Math.max(0.5, this.pdfZoom - 0.25);
            
            
            await rerenderPages();
            
          }
        });
        
        this._trackListener(zoomInBtn, 'click', async () => {
          
          if (this.pdfZoom < 3.0) {
            this.pdfZoom = Math.min(3.0, this.pdfZoom + 0.25);
            
            
            await rerenderPages();
            
          }
        });
        
        // Update current page on scroll
        this._trackListener(pdfContainer, 'scroll', () => {
          for (let i = 0; i < pages.length; i++) {
            const rect = pages[i].canvas.getBoundingClientRect();
            if (rect.top >= 0 && rect.top < window.innerHeight / 2) {
              const pageNum = parseInt(pages[i].canvas.dataset.pageNum);
              if (pageNum !== currentPage) {
                currentPage = pageNum;
                pageInfo.textContent = `Page ${pageNum} of ${pdf.numPages}`;
              }
              break;
            }
          }
        });
        
      }
      
      
    } catch (error) {
      throw error;
    }
  }

  /**
   * Track an event listener for lifecycle cleanup
   * @private
   */
  _trackListener(element, event, handler, options) {
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  /**
   * Remove all tracked listeners
   * @private
   */
  _clearListeners() {
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];
  }

  /**
   * Cleanup on modal close (called by BaseModal).
   * Removes ALL tracked listeners (element-level + document-level) and resets state.
   * @private
   */
  _cleanup() {
    this._clearListeners();
    
    // Reset zoom/pan state
    this.currentImg = null;
    this.currentZoom = 1;
    this.currentX = 0;
    this.currentY = 0;
    this.isDragging = false;
    this.pdfPages = [];
    this.pdfZoom = 1.0;
    this.zoomResetBtn = null;
    this.pdfZoomLevel = null;
    this.currentFile = null;
    
    // Chat summary view references
    this._summaryViewEl = null;
    this._rawViewEl = null;
  }
}

module.exports = FileViewerModal;
