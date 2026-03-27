'use strict';

let _styleRefCount = 0;

class CodeViewRenderer {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.ace = null;
    this.hljs = null;
    this.librariesLoaded = false;
  }

  injectStyles() {
    const styleId = 'code-viewer-styles';
    const existingEl = document.getElementById(styleId);

    if (!existingEl && _styleRefCount > 0) {
      _styleRefCount = 0;
    }

    _styleRefCount++;
    if (existingEl) {
      return;
    }

    const styles = `
      /* Code Viewer Container */
      .${this.config.CLASS_NAMES.CONTAINER} {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      /* Code Tabs Header — hidden by default (single-tab mode) */
      .${this.config.CLASS_NAMES.TABS_HEADER} {
        display: flex;
        gap: 4px;
        padding: 6px 8px;
        background: transparent;
        border-bottom: none;
        overflow-x: auto;
        flex-shrink: 0;
      }

      .${this.config.CLASS_NAMES.TAB_BUTTON} {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-tertiary);
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        white-space: nowrap;
        position: relative;
        overflow: hidden;
      }

      .${this.config.CLASS_NAMES.TAB_BUTTON}::before {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(255, 255, 255, 0.04);
        opacity: 0;
        transition: opacity 0.2s;
      }

      .${this.config.CLASS_NAMES.TAB_BUTTON}:hover {
        color: var(--color-text-primary);
        background: rgba(255, 255, 255, 0.06);
        border-color: transparent;
      }

      .${this.config.CLASS_NAMES.TAB_BUTTON}:hover::before {
        opacity: 1;
      }

      .${this.config.CLASS_NAMES.TAB_BUTTON}.${this.config.CLASS_NAMES.ACTIVE_TAB} {
        color: var(--color-text-primary);
        background: rgba(255, 255, 255, 0.08);
        border-color: transparent;
        box-shadow: none;
        font-weight: var(--font-weight-semibold);
      }

      .${this.config.CLASS_NAMES.TAB_CLOSE} {
        width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--font-size-sm);
        color: var(--color-text-disabled);
        background: transparent;
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        z-index: 1;
      }

      .${this.config.CLASS_NAMES.TAB_CLOSE}:hover {
        color: var(--color-error);
        background: var(--color-error-bg);
      }

      .${this.config.CLASS_NAMES.TABS_CONTENT} {
        flex: 1;
        position: relative;
        overflow: hidden;
      }

      .${this.config.CLASS_NAMES.TAB_CONTENT} {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: none;
        flex-direction: column;
        overflow: hidden;
      }

      .${this.config.CLASS_NAMES.TAB_CONTENT}.${this.config.CLASS_NAMES.ACTIVE_TAB} {
        display: flex;
      }

      .${this.config.CLASS_NAMES.CODE_EDITOR} {
        flex: 1;
        overflow: auto;
        background: transparent;
        position: relative;
        min-height: 0;
      }

      .${this.config.CLASS_NAMES.CODE_DISPLAY} pre {
        margin: 0;
        padding: 16px;
        font-family: var(--font-family-mono);
        font-size: var(--font-size-sm);
        line-height: 1.6;
        color: var(--color-text-primary);
        background: transparent;
        overflow-x: hidden;
        white-space: pre-wrap;
        word-wrap: break-word;
        word-break: break-word;
        width: 100%;
        height: 100%;
      }
      
      .${this.config.CLASS_NAMES.CODE_DISPLAY} pre code {
        display: block;
        width: 100%;
        height: 100%;
      }
    `;

    const styleElement = document.createElement('style');
    styleElement.id = styleId;
    styleElement.textContent = styles;
    document.head.appendChild(styleElement);

    this.log.debug('[CodeViewRenderer] Styles injected');
  }

  removeStyles() {
    _styleRefCount = Math.max(0, _styleRefCount - 1);
    if (_styleRefCount === 0) {
      const styleEl = document.getElementById('code-viewer-styles');
      if (styleEl && styleEl.parentNode) {
        styleEl.parentNode.removeChild(styleEl);
      }
    }
  }

  loadLibraries(aether) {
    if (this.librariesLoaded) return;
    try {
      if (window.ace) {
        this.ace = window.ace;
      } else if (aether?.ace) {
        this.ace = aether.ace;
      }

      if (window.hljs) {
        this.hljs = window.hljs;
      } else if (aether?.hljs) {
        this.hljs = aether.hljs;
      }
      this.librariesLoaded = true;
    } catch (error) {
      this.log.error('[CodeViewRenderer] Failed to load libraries:', error);
    }
  }

  createStructure(container) {
    container.classList.add(this.config.CLASS_NAMES.CONTAINER);

    const tabsHeader = document.createElement('div');
    tabsHeader.className = this.config.CLASS_NAMES.TABS_HEADER;

    const tabsContent = document.createElement('div');
    tabsContent.className = this.config.CLASS_NAMES.TABS_CONTENT;

    container.appendChild(tabsHeader);
    container.appendChild(tabsContent);

    return { tabsHeader, tabsContent };
  }

  createTabButton(tabId, label) {
    const button = document.createElement('div');
    button.className = this.config.CLASS_NAMES.TAB_BUTTON;
    button.dataset.tabId = tabId;

    const labelSpan = document.createElement('span');
    labelSpan.className = this.config.CLASS_NAMES.TAB_LABEL;
    labelSpan.textContent = label;

    const closeBtn = document.createElement('button');
    closeBtn.className = this.config.CLASS_NAMES.TAB_CLOSE;
    closeBtn.textContent = '×';
    closeBtn.title = 'Close tab';

    button.appendChild(labelSpan);
    button.appendChild(closeBtn);

    return { button, closeBtn };
  }

  createTabContent(tabId, tabsContentEl) {
    const content = document.createElement('div');
    content.className = this.config.CLASS_NAMES.TAB_CONTENT;
    content.dataset.tabId = tabId;
    tabsContentEl.appendChild(content);
    return content;
  }

  createEditor(container, code, language) {
    const editorEl = document.createElement('div');
    editorEl.className = this.config.CLASS_NAMES.CODE_EDITOR;
    container.appendChild(editorEl);

    if (this.ace) {
      try {
        const editor = this.ace.edit(editorEl);
        editor.setTheme(`ace/theme/${this.config.CODE.DEFAULT_THEME}`);
        this.setEditorLanguage(editor, language);
        editor.setValue(code, -1);
        editor.setOptions({
          fontSize: '13px',
          fontFamily: 'var(--font-family-mono, "Fira Code", "Consolas", monospace)',
          showLineNumbers: this.config.CODE.SHOW_LINE_NUMBERS,
          showGutter: this.config.CODE.SHOW_GUTTER,
          highlightActiveLine: this.config.CODE.HIGHLIGHT_ACTIVE_LINE,
          highlightSelectedWord: true,
          tabSize: this.config.CODE.TAB_SIZE,
          wrap: this.config.CODE.WRAP,
          enableBasicAutocompletion: this.config.CODE.ENABLE_LIVE_AUTOCOMPLETION,
          enableLiveAutocompletion: this.config.CODE.ENABLE_LIVE_AUTOCOMPLETION,
          enableSnippets: true,
          showPrintMargin: false,
          useSoftTabs: true,
          behavioursEnabled: true,
          displayIndentGuides: true,
          fadeFoldWidgets: false,
          showFoldWidgets: true,
        });
        return { editor, editorEl };
      } catch (error) {
        this.log.error('[CodeViewRenderer] Failed to create ACE editor:', error);
      }
    }

    // Fallback
    editorEl.className += ` ${this.config.CLASS_NAMES.CODE_DISPLAY}`;
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    codeEl.className = `language-${language}`;
    pre.appendChild(codeEl);
    editorEl.appendChild(pre);
    
    if (this.hljs) {
      try {
        this.hljs.highlightElement(codeEl);
      } catch (error) {
        this.log.error('[CodeViewRenderer] Failed to highlight code:', error);
      }
    }

    return { editor: null, editorEl, codeEl };
  }

  createControls(container, languageDisplayName) {
    const controls = document.createElement('div');
    controls.className = `${this.config.CLASS_NAMES.CODE_CONTROLS} code-controls`;

    const langBadge = document.createElement('div');
    langBadge.className = 'code-language-badge';
    langBadge.textContent = languageDisplayName;
    controls.appendChild(langBadge);

    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    controls.appendChild(spacer);

    const copyBtn = document.createElement('button');
    copyBtn.dataset.action = 'copy';
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg><span>Copy</span>`;
    copyBtn.title = 'Copy code to clipboard';

    const exportBtn = document.createElement('button');
    exportBtn.dataset.action = 'export';
    exportBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg><span>Export</span>`;
    exportBtn.title = 'Export to file';

    controls.appendChild(copyBtn);
    controls.appendChild(exportBtn);

    container.appendChild(controls);

    return { controls, copyBtn, exportBtn, langBadge };
  }

  setEditorLanguage(editor, language) {
    if (!editor) return;
    try {
      const mode = this.getAceMode(language);
      editor.session.setMode(`ace/mode/${mode}`);
    } catch (error) {
      this.log.error('[CodeViewRenderer] Failed to set editor language:', error);
    }
  }

  getAceMode(language) {
    const langMap = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'rb': 'ruby',
      'sh': 'sh',
      'bash': 'sh',
      'zsh': 'sh',
      'cs': 'csharp',
      'md': 'markdown',
      'yml': 'yaml',
    };
    return langMap[language] || language;
  }
}

module.exports = CodeViewRenderer;