'use strict';

/**
 * @.architecture
 * Incoming: ChatWindow (creates button), parent passes context data --- {HTMLElement, context_data}
 * Processing: Render button with usage indicator, update display --- {JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: DOM button element, click events --- {HTMLElement, Event}
 * 
 * ARCHITECTURAL RULES:
 * - NO HTTP calls (completely offline component)
 * - NO hardcoded values (all from backend via parent)
 * - NO business logic (pure presentation)
 * - Backend is SINGLE SOURCE OF TRUTH
 * 
 * @module renderer/chat/components/CircularRingButton
 */

/**
 * Circular Ring Button Component
 * 
 * Minimalist button showing context status via color.
 * Parent fetches data from backend and calls updateDisplay().
 */
class CircularRingButton {
  constructor(options = {}) {
    this.onClick = options.onClick || (() => {});
    
    // State (set by parent via updateDisplay)
    this.usagePercent = 0;
    this.tokenCount = 0;
    this.tokenLimit = 0;
    this.thresholds = { warning: 0.8, high: 0.9, critical: 0.95 }; // Default percentages
    
    // DOM
    this.button = null;
    
    this._createElement();
  }

  _createElement() {
    this.button = document.createElement('button');
    this.button.className = 'context-ring-button';
    this.button.title = 'View Current Context';
    this.button.setAttribute('aria-label', 'View current context and token usage');
    
    // Circular progress ring with center icon
    // pointer-events: none on SVG and text overlay ensures all clicks
    // reach the button element directly (prevents intermittent click failures)
    this.button.innerHTML = `
      <svg width="28" height="28" viewBox="0 0 36 36" style="transform: rotate(-90deg); pointer-events: none;">
        <!-- Background circle -->
        <circle cx="18" cy="18" r="15" 
                fill="none" 
                stroke="var(--color-border-subtle)" 
                stroke-width="2.5"/>
        <!-- Progress circle -->
        <circle cx="18" cy="18" r="15" 
                fill="none" 
                stroke="currentColor" 
                stroke-width="2.5"
                stroke-dasharray="94.25"
                stroke-dashoffset="94.25"
                class="progress-ring"
                style="transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;"/>
      </svg>
      <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 9px; font-weight: var(--font-weight-semibold); color: var(--color-text-primary); pointer-events: none;" class="usage-text">0%</div>
    `;
    
    this.button.classList.add('circular-ring-btn');
    
    // Store reference to progress ring for updates
    this.progressRing = this.button.querySelector('.progress-ring');
    this.usageText = this.button.querySelector('.usage-text');
    
    // Hover handled via CSS: .circular-ring-btn:hover { transform: scale(1.1) }
    this.button.addEventListener('click', () => this.onClick());
  }

  /**
   * Update display with context data from backend
   * 
   * @param {Object} contextStatus - Context status from backend API
   * @param {number} contextStatus.usage_percent - Usage percentage (0-100)
   * @param {number} contextStatus.token_count - Current token count
   * @param {number} contextStatus.token_limit - Token limit
   * @param {Object} contextStatus.thresholds - Threshold values from backend
   */
  updateDisplay(contextStatus) {
    if (!contextStatus) return;
    
    // Support both snake_case (backend) and camelCase (potential frontend drift)
    this.usagePercent = contextStatus.usage_percent ?? contextStatus.usagePercent ?? 0;
    this.tokenCount = contextStatus.token_count ?? contextStatus.tokenCount ?? 0;
    this.tokenLimit = contextStatus.token_limit ?? contextStatus.tokenLimit ?? 0;
    
    // Convert backend token thresholds to percentages
    if (contextStatus.thresholds) {
      const limit = this.tokenLimit || 1;
      const t = contextStatus.thresholds;
      
      // Handle both absolute counts and percentages from backend
      this.thresholds = {
        warning: t.warning > 100 ? t.warning / limit : (t.warning || 80) / 100,
        high: t.high > 100 ? t.high / limit : (t.high || 90) / 100,
        critical: t.critical > 100 ? t.critical / limit : (t.critical || 95) / 100
      };
    }
    
    this._updateVisuals();
  }

  _updateVisuals() {
    const usageDecimal = this.usagePercent / 100;
    
    // Color based on backend thresholds
    let ringColor;
    if (usageDecimal >= this.thresholds.critical) {
      ringColor = 'var(--color-error)';
    } else if (usageDecimal >= this.thresholds.high) {
      ringColor = 'var(--color-warning)';
    } else if (usageDecimal >= this.thresholds.warning) {
      ringColor = 'var(--color-info)';
    } else {
      ringColor = 'var(--color-success)';
    }
    
    // Update progress ring
    if (this.progressRing) {
      const circumference = 94.25;  // 2 * PI * 15
      const offset = circumference * (1 - usageDecimal);
      this.progressRing.style.strokeDashoffset = offset.toString();
      this.button.style.color = ringColor;
    }
    
    // Update center text
    if (this.usageText) {
      // Show decimal for values < 1%, otherwise round
      const displayText = this.usagePercent < 1 
        ? `${this.usagePercent.toFixed(1)}%`
        : `${Math.round(this.usagePercent)}%`;
      this.usageText.textContent = displayText;
      this.usageText.style.color = ringColor;
    }
    
    // Update tooltip
    if (this.tokenLimit > 0) {
      this.button.title = `Context: ${this.tokenCount.toLocaleString()} / ${this.tokenLimit.toLocaleString()} tokens (${this.usagePercent.toFixed(1)}%)`;
    } else {
      this.button.title = 'View Current Context';
    }
  }

  getElement() {
    return this.button;
  }

  dispose() {
    if (this.button && this.button.parentNode) {
      this.button.parentNode.removeChild(this.button);
    }
    this.button = null;
  }
}

module.exports = CircularRingButton;
