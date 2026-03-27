'use strict';

const BaseComponent = require('./BaseComponent');
const IndexBrowserUtils = require('../IndexBrowserUtils');

class SearchBarComponent extends BaseComponent {
  constructor(container, ctx, uiText, uiConfig) {
    super(container, ctx);
    this.uiText = uiText;
    this.uiConfig = uiConfig;
    this.render();
  }

  render() {
    const query = IndexBrowserUtils.escapeAttr(this.ctx.searchService.searchQuery);
    
    this.container.innerHTML = `
      <div class="se-bar">
        <button class="se-hamburger-btn se-sidebar-toggle-btn" type="button" title="${this.uiText.FILTERS.settings}">
          <i class="fas fa-bars"></i>
        </button>
        <div class="se-bar-wrapper">
          <div class="se-bar-icon" id="search-bar-icon">
            <i class="fas fa-search"></i>
          </div>
          <input
            type="text"
            class="se-bar-input"
            id="search-bar-input"
            placeholder="${this.uiText.SEARCH.placeholder}"
            value="${query}"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="se-bar-clear is-hidden" id="search-bar-clear" title="Clear search" type="button">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <button class="se-bar-btn" id="search-bar-btn" type="button">
          ${this.uiText.SEARCH.button}
        </button>
      </div>`;

    this._attachListeners();
  }

  _attachListeners() {
    const input = this.container.querySelector('#search-bar-input');
    const btn = this.container.querySelector('#search-bar-btn');
    const clearBtn = this.container.querySelector('#search-bar-clear');
    const sidebarToggleBtn = this.container.querySelector('.se-sidebar-toggle-btn');

    if (input) {
      this._trackListener(input, 'keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.ctx.searchService.searchQuery = input.value;
          this.ctx.executeSearch();
        }
      });

      this._trackListener(input, 'input', () => {
        this.ctx.searchService.searchQuery = input.value;
        this.update(); // Update clear button visibility immediately
      });

      // Auto-focus search input
      requestAnimationFrame(() => input.focus());
    }

    if (btn) {
      this._trackListener(btn, 'click', () => {
        this.ctx.searchService.searchQuery = input?.value || '';
        this.ctx.executeSearch();
      });
    }

    if (clearBtn) {
      this._trackListener(clearBtn, 'click', () => {
        this.ctx.searchService.clearSearch();
        if (input) {
          input.value = '';
          input.focus();
        }
        this.update();
      });
    }

    if (sidebarToggleBtn) {
      this._trackListener(sidebarToggleBtn, 'click', () => {
        this.ctx.toggleSidebar(!this.ctx.sourcesExpanded);
      });
    }
  }

  update() {
    const searching = this.ctx.searchService.isSearching;
    const query = this.ctx.searchService.searchQuery;

    const iconContainer = this.container.querySelector('#search-bar-icon');
    if (iconContainer) {
      iconContainer.innerHTML = searching 
        ? '<span class="se-bar-spinner"></span>'
        : '<i class="fas fa-search"></i>';
    }

    const clearBtn = this.container.querySelector('#search-bar-clear');
    if (clearBtn) {
      clearBtn.classList.toggle('is-hidden', !query);
    }

    const btn = this.container.querySelector('#search-bar-btn');
    if (btn) {
      btn.disabled = searching;
      btn.textContent = searching ? this.uiText.SEARCH.buttonActive : this.uiText.SEARCH.button;
    }
    
    // Ensure input value stays in sync if cleared externally
    const input = this.container.querySelector('#search-bar-input');
    if (input && input.value !== query && document.activeElement !== input) {
        input.value = query;
    }
  }

  dispose() {
    super.dispose();
  }
}

module.exports = SearchBarComponent;
