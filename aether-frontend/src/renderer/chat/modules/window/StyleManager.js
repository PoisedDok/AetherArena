'use strict';

/**
 * @.architecture
 * 
 * Incoming: ChatWindow.init() → injectStyles() call --- {none, method_call}
 * Processing: Generate comprehensive CSS stylesheet (711 lines), inject once into document.head via <style> element, prevent duplicate injection via ID check --- {1 job: JOB_CREATE_DOM_ELEMENT}
 * Outgoing: document.head (<style> element with ID 'aether-chat-styles') --- {dom_types.dom_element, HTMLStyleElement}
 * 
 * 
 * @module renderer/chat/modules/window/StyleManager
 */

class StyleManager {
  constructor() {
    this.styleId = 'aether-chat-styles';
    this.injected = false;
  }

  /**
   * Inject CSS styles into document head
   * Idempotent - safe to call multiple times
   */
  injectStyles() {
    // Prevent duplicate injection
    if (this.injected || document.querySelector(`#${this.styleId}`)) {
      console.log('[StyleManager] Styles already injected');
      return;
    }

    const style = document.createElement('style');
    style.id = this.styleId;
    style.textContent = this.getChatStyles();
    document.head.appendChild(style);
    
    this.injected = true;
    console.log('[StyleManager] Styles injected successfully');
  }

  /**
   * Remove injected styles (cleanup)
   */
  removeStyles() {
    const style = document.querySelector(`#${this.styleId}`);
    if (style) {
      style.remove();
      this.injected = false;
      console.log('[StyleManager] Styles removed');
    }
  }

  /**
   * Get complete CSS stylesheet for chat window
   * @returns {string} CSS content
   */
  getChatStyles() {
    return `
/* ============================================================================
   Aether Chat Window Styles - Production Ready
   ============================================================================ */

/* Base Chat Window Container */
.aether-chat-window {
  position: fixed;
  width: 500px;
  height: 600px;
  min-width: 350px;
  min-height: 300px;
  background: rgba(18, 18, 18, 0.95);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
  z-index: 2000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
  box-sizing: border-box;
  backdrop-filter: blur(20px) saturate(130%);
  -webkit-backdrop-filter: blur(20px) saturate(130%);
  transition: box-shadow 0.2s ease;
}

/* Attached Mode - Positioned in main window */
.aether-chat-window.attached {
  position: fixed;
  bottom: 30px;
  right: 30px;
}

/* Detached Mode - Full window (Electron BrowserWindow) */
.aether-chat-window.detached {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  border-radius: 0 !important;
  border: none !important;
  box-shadow: none !important;
}

/* Hidden State */
.aether-chat-window.hidden {
  transform: translateY(calc(100% + 60px)) scale(0.95);
  opacity: 0;
  pointer-events: none;
  transition: transform 0.3s ease, opacity 0.3s ease;
}

/* Maximized State (attached mode only) */
.aether-chat-window.maximized {
  top: 20px !important;
  left: 20px !important;
  right: 20px !important;
  bottom: 20px !important;
  width: calc(100vw - 40px) !important;
  height: calc(100vh - 40px) !important;
}

/* Active State (dragging or resizing) */
.aether-chat-window.dragging,
.aether-chat-window.resizing {
  box-shadow: 0 15px 50px rgba(0, 0, 0, 0.8);
  border-color: rgba(255, 255, 255, 0.3);
  transition: none;
}

/* ============================================================================
   Window Header
   ============================================================================ */

.aether-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0.08),
    rgba(255, 255, 255, 0.04)
  );
  border-bottom: 1px solid rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  cursor: move;
  user-select: none;
  -webkit-user-select: none;
  flex-shrink: 0;
  gap: 8px;
}

.aether-chat-header:active {
  cursor: grabbing;
}

.aether-chat-title {
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0.3px;
}

.aether-chat-controls {
  display: flex;
  gap: 8px;
}

.aether-chat-control-btn {
  background: transparent;
  border: none;
  color: #a0a0a0;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 4px;
  transition: all 0.2s ease;
  font-size: 14px;
  min-width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.aether-chat-control-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}

.aether-chat-control-btn:active {
  background: rgba(255, 255, 255, 0.18);
}

/* ============================================================================
   Chat Content Area
   ============================================================================ */

.aether-chat-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px;
  min-height: 0;
  box-sizing: border-box;
  scroll-behavior: smooth;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
}

.aether-chat-content::-webkit-scrollbar {
  width: 8px;
}

.aether-chat-content::-webkit-scrollbar-track {
  background: transparent;
}

.aether-chat-content::-webkit-scrollbar-thumb {
  background-color: rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  transition: background-color 0.2s ease;
}

.aether-chat-content::-webkit-scrollbar-thumb:hover {
  background-color: rgba(255, 255, 255, 0.4);
}

/* ============================================================================
   Chat Messages
   ============================================================================ */

.chat-entry {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  animation: messageSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.chat-entry:last-child {
  margin-bottom: 0;
  border-bottom: none;
}

@keyframes messageSlideIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.chat-timestamp {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  margin-bottom: 6px;
  font-weight: 500;
}

.chat-text {
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.chat-text.user {
  color: #d1d5db;
}

.chat-text.assistant {
  color: #e0e0e0;
}

.chat-text.system {
  color: rgba(255, 255, 255, 0.55);
  font-style: italic;
  font-size: 13px;
}

/* ============================================================================
   Markdown Rendering
   ============================================================================ */

.chat-text h1, .chat-text h2, .chat-text h3, 
.chat-text h4, .chat-text h5, .chat-text h6 {
  margin: 0.6em 0 0.4em;
  font-weight: 600;
  color: #ffffff;
  line-height: 1.3;
}

.chat-text h1 { font-size: 1.5em; }
.chat-text h2 { font-size: 1.35em; }
.chat-text h3 { font-size: 1.2em; }
.chat-text h4 { font-size: 1.1em; }
.chat-text h5 { font-size: 1.05em; }
.chat-text h6 { font-size: 1em; }

.chat-text p {
  margin: 0.5em 0;
  line-height: 1.6;
}

.chat-text p:first-child {
  margin-top: 0;
}

.chat-text p:last-child {
  margin-bottom: 0;
}

.chat-text ul, .chat-text ol {
  margin: 0.5em 0;
  padding-left: 1.8em;
}

.chat-text li {
  margin: 0.2em 0;
  line-height: 1.5;
}

.chat-text ul li {
  list-style-type: disc;
}

.chat-text ol li {
  list-style-type: decimal;
}

.chat-text blockquote {
  border-left: 3px solid rgba(255, 255, 255, 0.3);
  margin: 0.5em 0;
  padding-left: 1em;
  color: rgba(255, 255, 255, 0.75);
  font-style: italic;
}

.chat-text code {
  background: rgba(255, 255, 255, 0.1);
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-family: 'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 0.9em;
  color: #ffa726;
}

.chat-text pre {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 12px;
  margin: 0.5em 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.chat-text pre code {
  background: none;
  padding: 0;
  font-size: 0.85em;
  color: inherit;
}

.chat-text table,
.chat-text .markdown-table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  font-size: 0.9em;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.chat-text th,
.chat-text td {
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 0.6em 0.8em;
  text-align: left;
  word-wrap: break-word;
}

.chat-text th {
  background: rgba(255, 255, 255, 0.1);
  font-weight: 600;
  color: #ffffff;
}

.chat-text tbody tr:nth-child(even) {
  background: rgba(255, 255, 255, 0.03);
}

.chat-text tbody tr:hover {
  background: rgba(255, 255, 255, 0.06);
}

.chat-text a {
  color: #81c784;
  text-decoration: none;
  border-bottom: 1px solid rgba(129, 199, 132, 0.3);
  transition: all 0.2s ease;
}

.chat-text a:hover {
  color: #a5d6a7;
  border-bottom-color: rgba(165, 214, 167, 0.6);
}

.chat-text hr {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.2);
  margin: 1.2em 0;
}

.chat-text strong {
  font-weight: 600;
  color: #ffffff;
}

.chat-text em {
  font-style: italic;
}

/* ============================================================================
   Input Area
   ============================================================================ */

.aether-chat-input-wrapper {
  display: flex;
  align-items: flex-end;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.02);
  flex-shrink: 0;
}

.aether-chat-input {
  flex: 1;
  background: transparent;
  border: none;
  color: #ffffff;
  resize: none;
  padding: 14px 16px;
  font-family: inherit;
  font-size: 14px;
  outline: none;
  max-height: 150px;
  min-height: 44px;
  line-height: 1.5;
}

.aether-chat-input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.aether-chat-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.aether-chat-btn {
  background: transparent;
  border: none;
  color: #a0a0a0;
  padding: 12px 16px;
  cursor: pointer;
  font-size: 18px;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
}

.aether-chat-btn:hover:not(:disabled) {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.1);
}

.aether-chat-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Send button states */
.aether-chat-send-btn.stop-mode {
  color: #fca5a5;
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

/* ============================================================================
   Resize Handles (attached mode only)
   ============================================================================ */

.resize-handle {
  position: absolute;
  z-index: 200;
  background: transparent;
  transition: background-color 0.2s ease;
}

.resize-handle:hover {
  background: rgba(255, 255, 255, 0.15);
}

/* Hide in detached mode */
.aether-chat-window.detached .resize-handle {
  display: none !important;
}

/* Edge handles */
.resize-n {
  top: -5px;
  left: 10px;
  right: 10px;
  height: 10px;
  cursor: n-resize;
}

.resize-s {
  bottom: -5px;
  left: 10px;
  right: 10px;
  height: 10px;
  cursor: s-resize;
}

.resize-e {
  right: -5px;
  top: 10px;
  bottom: 10px;
  width: 10px;
  cursor: e-resize;
}

.resize-w {
  left: -5px;
  top: 10px;
  bottom: 10px;
  width: 10px;
  cursor: w-resize;
}

/* Corner handles */
.resize-ne {
  top: -5px;
  right: -5px;
  width: 15px;
  height: 15px;
  cursor: ne-resize;
}

.resize-nw {
  top: -5px;
  left: -5px;
  width: 15px;
  height: 15px;
  cursor: nw-resize;
}

.resize-se {
  bottom: -5px;
  right: -5px;
  width: 15px;
  height: 15px;
  cursor: se-resize;
}

.resize-sw {
  bottom: -5px;
  left: -5px;
  width: 15px;
  height: 15px;
  cursor: sw-resize;
}

/* ============================================================================
   File Attachments
   ============================================================================ */

.attachment-preview {
  margin-top: 8px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 6px;
  overflow: hidden;
  max-width: 95%;
}

.attached-image {
  max-width: 300px;
  max-height: 200px;
  border-radius: 6px;
  display: block;
}

.file-list-preview {
  padding: 10px 12px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.file-attachment-icon {
  font-size: 24px;
  opacity: 0.8;
}

.file-attachment-details {
  flex: 1;
  min-width: 0;
}

.inline-file-list {
  list-style: none;
  padding: 0;
  margin: 4px 0 0 0;
  font-size: 12px;
  color: #b3e5fc;
}

.inline-file-list li {
  padding: 2px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ============================================================================
   Processing Indicators
   ============================================================================ */

.processing-indicator,
.queued-indicator {
  display: block;
  color: #fbbf24;
  margin-top: 6px;
  font-size: 12px;
  font-style: italic;
  animation: pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.queued-indicator {
  color: #60a5fa;
}

/* ============================================================================
   Accessibility
   ============================================================================ */

@media (prefers-reduced-motion: reduce) {
  .aether-chat-window,
  .chat-entry,
  .aether-chat-btn,
  .processing-indicator {
    animation: none !important;
    transition: none !important;
  }
}

/* ============================================================================
   Print Styles
   ============================================================================ */

@media print {
  .aether-chat-window {
    position: static !important;
    width: 100% !important;
    height: auto !important;
    border: 1px solid #000;
    box-shadow: none;
    background: #fff;
    color: #000;
  }
  
  .aether-chat-header,
  .aether-chat-input-wrapper,
  .resize-handle {
    display: none !important;
  }
  
  .aether-chat-content {
    overflow: visible !important;
    padding: 20px;
  }
}
`;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.removeStyles();
    console.log('[StyleManager] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StyleManager;
}

if (typeof window !== 'undefined') {
  window.StyleManager = StyleManager;
  console.log('📦 StyleManager loaded');
}

