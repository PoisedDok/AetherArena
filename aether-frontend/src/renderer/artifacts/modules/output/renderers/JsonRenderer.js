'use strict';

/**
 * @.architecture
 * 
 * Incoming: OutputViewer.render() → JSON string or object --- {artifact_types.console_output, json}
 * Processing: Parse JSON string if needed, render recursive tree view with type-specific color coding (string/number/boolean/null/array/object), indent based on nesting level --- {2 jobs: JOB_CREATE_DOM_ELEMENT, JOB_PARSE_JSON}
 * Outgoing: DOM (syntax-highlighted JSON tree) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/output/renderers/JsonRenderer
 */

const BaseRenderer = require('./BaseRenderer');
const { freeze } = Object;

const CONFIG = freeze({
  CLASS_NAMES: freeze({
    CONTAINER: 'json-renderer-container',
    TREE: 'json-tree',
    KEY: 'json-key',
    VALUE: 'json-value',
    STRING: 'json-string',
    NUMBER: 'json-number',
    BOOLEAN: 'json-boolean',
    NULL: 'json-null',
  }),
  MAX_INLINE_LENGTH: 80,
});

class JsonRenderer extends BaseRenderer {
  constructor(options = {}) {
    super(options);
  }

  async render(data, container) {
    try {
      // Parse if string
      let jsonData;
      if (typeof data === 'string') {
        try {
          jsonData = JSON.parse(data);
        } catch (e) {
          jsonData = data;
        }
      } else {
        jsonData = data;
      }

      if (jsonData === null || jsonData === undefined) {
        const emptyEl = this.createEmptyMessage('No JSON data to display');
        this.prepareContainer(container);
        container.appendChild(emptyEl);
        return;
      }

      this._injectStyles();
      this.prepareContainer(container);
      container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);

      // Create tree view
      const tree = this._renderValue(jsonData);
      container.appendChild(tree);

      console.log('[JsonRenderer] Rendered JSON data');

    } catch (error) {
      console.error('[JsonRenderer] Render failed:', error);
      this.handleError(container, error, 'Failed to render JSON');
    }
  }

  _renderValue(value, key = null, level = 0) {
    const container = document.createElement('div');
    container.className = CONFIG.CLASS_NAMES.TREE;
    container.style.marginLeft = `${level * 20}px`;

    if (key !== null) {
      const keySpan = document.createElement('span');
      keySpan.className = CONFIG.CLASS_NAMES.KEY;
      keySpan.textContent = `"${key}": `;
      container.appendChild(keySpan);
    }

    if (value === null) {
      const valueSpan = document.createElement('span');
      valueSpan.className = `${CONFIG.CLASS_NAMES.VALUE} ${CONFIG.CLASS_NAMES.NULL}`;
      valueSpan.textContent = 'null';
      container.appendChild(valueSpan);
    } else if (typeof value === 'boolean') {
      const valueSpan = document.createElement('span');
      valueSpan.className = `${CONFIG.CLASS_NAMES.VALUE} ${CONFIG.CLASS_NAMES.BOOLEAN}`;
      valueSpan.textContent = String(value);
      container.appendChild(valueSpan);
    } else if (typeof value === 'number') {
      const valueSpan = document.createElement('span');
      valueSpan.className = `${CONFIG.CLASS_NAMES.VALUE} ${CONFIG.CLASS_NAMES.NUMBER}`;
      valueSpan.textContent = String(value);
      container.appendChild(valueSpan);
    } else if (typeof value === 'string') {
      const valueSpan = document.createElement('span');
      valueSpan.className = `${CONFIG.CLASS_NAMES.VALUE} ${CONFIG.CLASS_NAMES.STRING}`;
      valueSpan.textContent = `"${value}"`;
      container.appendChild(valueSpan);
    } else if (Array.isArray(value)) {
      const arrayContainer = document.createElement('div');
      arrayContainer.textContent = '[';
      container.appendChild(arrayContainer);

      value.forEach((item, index) => {
        const itemEl = this._renderValue(item, null, level + 1);
        container.appendChild(itemEl);
      });

      const closeBracket = document.createElement('div');
      closeBracket.textContent = ']';
      closeBracket.style.marginLeft = `${level * 20}px`;
      container.appendChild(closeBracket);
    } else if (typeof value === 'object') {
      const objectContainer = document.createElement('div');
      objectContainer.textContent = '{';
      container.appendChild(objectContainer);

      Object.keys(value).forEach((k) => {
        const itemEl = this._renderValue(value[k], k, level + 1);
        container.appendChild(itemEl);
      });

      const closeBrace = document.createElement('div');
      closeBrace.textContent = '}';
      closeBrace.style.marginLeft = `${level * 20}px`;
      container.appendChild(closeBrace);
    }

    return container;
  }

  _injectStyles() {
    const styleId = 'json-renderer-styles';
    const styles = `
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        padding: 16px;
        background: #1e1e1e;
        color: #d4d4d4;
        font-family: 'Courier New', monospace;
        font-size: 13px;
        line-height: 1.6;
        overflow: auto;
      }
      .${CONFIG.CLASS_NAMES.TREE} {
        margin: 2px 0;
      }
      .${CONFIG.CLASS_NAMES.KEY} {
        color: #9cdcfe;
      }
      .${CONFIG.CLASS_NAMES.VALUE} {
        margin-left: 4px;
      }
      .${CONFIG.CLASS_NAMES.STRING} {
        color: #ce9178;
      }
      .${CONFIG.CLASS_NAMES.NUMBER} {
        color: #b5cea8;
      }
      .${CONFIG.CLASS_NAMES.BOOLEAN} {
        color: #569cd6;
      }
      .${CONFIG.CLASS_NAMES.NULL} {
        color: #569cd6;
      }
    `;
    this.injectStyles(styleId, styles);
  }
}

module.exports = JsonRenderer;

if (typeof window !== 'undefined') {
  window.JsonRenderer = JsonRenderer;
  console.log('📦 JsonRenderer loaded');
}

