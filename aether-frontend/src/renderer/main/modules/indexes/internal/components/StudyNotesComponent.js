'use strict';

const BaseComponent = require('./BaseComponent');
const IndexBrowserUtils = require('../IndexBrowserUtils');

class StudyNotesComponent extends BaseComponent {
  constructor(container, ctx) {
    super(container, ctx);
    
    // Load persisted state
    const saved = this._loadState();
    this.noteTitle = saved.title || 'My Study Notes';
    this.noteContent = saved.content || '';
    
    this.isOpen = false;
    this.saveTimeout = null;
    this.telemetryTimeout = null;
    
    this.render();
  }

  _loadState() {
    try {
      const raw = localStorage.getItem('aether-study-notes');
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return {};
  }

  _saveState() {
    try {
      localStorage.setItem('aether-study-notes', JSON.stringify({
        title: this.noteTitle,
        content: this.noteContent
      }));
    } catch (_) {}
  }

  _triggerTelemetry() {
    // Disabled as per user request to avoid complicating logs with user writing/typing data
    // We only track the opened results from searches.
    return;
  }

  _scheduleSaveAndTelemetry() {
    // Save to local storage
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this._saveState();
    }, 500); // 500ms debounce for local storage
  }

  toggle(forceState) {
    this.isOpen = forceState !== undefined ? forceState : !this.isOpen;
    if (this.container) {
      if (this.isOpen) {
        this.container.classList.add('is-open');
      } else {
        this.container.classList.remove('is-open');
      }
    }
  }

  render() {
    this.container.innerHTML = `
      <style>
        .se-study-notes-wrapper {
          position: fixed;
          bottom: 20px;
          right: 20px;
          width: 350px;
          height: 400px;
          background: var(--surface-2, #1e1e1e);
          border: 1px solid var(--border-color, #333);
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          box-shadow: 0 10px 30px rgba(0,0,0,0.5);
          z-index: var(--z-tooltip);
          transform: translateY(120%);
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .is-open .se-study-notes-wrapper {
          transform: translateY(0);
        }
        .se-study-notes-header {
          display: flex;
          align-items: center;
          padding: 10px;
          border-bottom: 1px solid var(--border-color, #333);
          background: var(--surface-1, #252526);
          border-radius: 8px 8px 0 0;
        }
        .se-study-notes-title {
          flex: 1;
          background: transparent;
          border: none;
          color: var(--text-primary, #fff);
          font-weight: 600;
          font-size: 14px;
          outline: none;
        }
        .se-study-notes-actions button {
          background: transparent;
          border: none;
          color: var(--text-secondary, #aaa);
          cursor: pointer;
          padding: 4px 8px;
          transition: color 0.2s;
        }
        .se-study-notes-actions button:hover {
          color: var(--text-primary, #fff);
        }
        .se-study-notes-body {
          flex: 1;
          padding: 0;
          display: flex;
        }
        .se-study-notes-textarea {
          flex: 1;
          background: transparent;
          border: none;
          color: var(--text-primary, #fff);
          padding: 12px;
          padding-bottom: 28px; /* Space for word counter */
          resize: none;
          outline: none;
          font-family: inherit;
          line-height: 1.5;
        }
        .se-study-notes-word-counter {
          position: absolute;
          bottom: 8px;
          right: 12px;
          font-size: 11px;
          color: var(--text-secondary, #aaa);
          pointer-events: none;
          user-select: none;
          opacity: 0.6;
        }
      </style>
      <div class="se-study-notes-wrapper">
        <div class="se-study-notes-header">
          <input type="text" class="se-study-notes-title" value="${IndexBrowserUtils.escapeAttr(this.noteTitle)}" placeholder="Note Title..." />
          <div class="se-study-notes-actions">
            <button class="se-action-btn se-study-notes-open" type="button" title="Open text file">
              <i class="fas fa-folder-open"></i>
            </button>
            <button class="se-action-btn se-study-notes-save" type="button" title="Save as text file">
              <i class="fas fa-save"></i>
            </button>
            <button class="se-action-btn se-study-notes-detach" type="button" title="Detach to separate window">
              <i class="fas fa-external-link-alt"></i>
            </button>
            <button class="se-action-btn se-study-notes-close" type="button" title="Close Notes">
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>
        <div class="se-study-notes-body" style="position: relative;">
          <textarea class="se-study-notes-textarea" placeholder="Type your notes here...">${IndexBrowserUtils.escapeHtml(this.noteContent)}</textarea>
          <div class="se-study-notes-word-counter">0 words</div>
        </div>
      </div>
    `;
    this._attachListeners();
    this._updateWordCount();
  }

  _updateWordCount() {
    const counter = this.container.querySelector('.se-study-notes-word-counter');
    if (counter) {
      const text = this.noteContent.trim();
      const words = text ? text.split(/\s+/).length : 0;
      counter.textContent = `${words} word${words === 1 ? '' : 's'}`;
    }
  }

  _attachListeners() {
    const titleInput = this.container.querySelector('.se-study-notes-title');
    const textarea = this.container.querySelector('.se-study-notes-textarea');
    const closeBtn = this.container.querySelector('.se-study-notes-close');

    if (titleInput) {
      this._trackListener(titleInput, 'input', (e) => {
        this.noteTitle = e.target.value;
        this._scheduleSaveAndTelemetry();
      });
    }

    if (textarea) {
      this._trackListener(textarea, 'input', (e) => {
        this.noteContent = e.target.value;
        this._updateWordCount();
        this._scheduleSaveAndTelemetry();
      });
    }

    const openBtn = this.container.querySelector('.se-study-notes-open');
    if (openBtn) {
      this._trackListener(openBtn, 'click', async () => {
        const aether = window.aether;
        if (aether && aether.dialog && aether.dialog.readTextFile) {
          const result = await aether.dialog.readTextFile();
          if (result && result.content !== undefined) {
            this.noteContent = result.content;
            this.noteTitle = result.filename || 'Opened Note';
            if (titleInput) titleInput.value = this.noteTitle;
            if (textarea) textarea.value = this.noteContent;
            this._saveState();
          }
        }
      });
    }

    const saveBtn = this.container.querySelector('.se-study-notes-save');
    if (saveBtn) {
      this._trackListener(saveBtn, 'click', async () => {
        const aether = window.aether;
        if (aether && aether.dialog && aether.dialog.saveTextFile) {
          const defaultPath = this.noteTitle.endsWith('.txt') || this.noteTitle.endsWith('.md') 
            ? this.noteTitle 
            : `${this.noteTitle}.md`;
            
          const result = await aether.dialog.saveTextFile(this.noteContent, defaultPath);
          if (result && result.success) {
            // User requested not to clear notes after save
            this._saveState();
          }
        }
      });
    }

    const detachBtn = this.container.querySelector('.se-study-notes-detach');
    if (detachBtn) {
      this._trackListener(detachBtn, 'click', () => {
        const aether = window.aether;
        if (aether && aether.window && aether.window.openNotes) {
          aether.window.openNotes({
            title: this.noteTitle,
            content: this.noteContent
          });
          // Close the inline notes after detaching
          this.toggle(false);
        }
      });
    }

    if (closeBtn) {
      this._trackListener(closeBtn, 'click', () => {
        this.toggle(false);
      });
    }
  }

  dispose() {
    super.dispose();
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    if (this.telemetryTimeout) clearTimeout(this.telemetryTimeout);
  }
}

module.exports = StudyNotesComponent;