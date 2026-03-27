'use strict';

/**
 * @.architecture
 * 
 * Incoming: EventBus 'context:status-changed' --- {event, json}
 * Processing: Render token usage badge with color-coded status --- {2 jobs: JOB_RENDER, JOB_UPDATE_STATE}
 * Outgoing: DOM (chat header) --- {HTMLElement}
 * 
 * @module renderer/chat/components/ContextBadge
 * 
 * ContextBadge - Token Usage Visual Indicator
 * ===========================================
 * 
 * Displays real-time token usage percentage with color-coded status levels.
 * 
 * Status Colors:
 * - Normal (0-79%): Green
 * - Warning (80-89%): Yellow
 * - High (90-94%): Orange
 * - Critical (95%+): Red
 */

const { createRendererLogger } = require('../../shared/utils/logger');

class ContextBadge {
  constructor(options = {}) {
    this.log = createRendererLogger('ContextBadge');
    this.container = options.container || null;
    this.enableLogging = options.enableLogging || false;
    
    // State
    this.currentStatus = null;
    
    // DOM elements
    this.badge = null;
    this.progressBar = null;
    this.statusText = null;
    this.tooltip = null;
    
    if (!this.container) {
      throw new Error('[ContextBadge] container required');
    }
    
    this._init();
  }
  
  /**
   * Initialize badge
   * @private
   */
  _init() {
    // Create badge structure
    this.badge = document.createElement('div');
    this.badge.className = 'context-badge';
    this.badge.setAttribute('role', 'status');
    this.badge.setAttribute('aria-label', 'Context usage indicator');
    
    // Progress bar
    this.progressBar = document.createElement('div');
    this.progressBar.className = 'context-badge__progress';
    
    const progressFill = document.createElement('div');
    progressFill.className = 'context-badge__fill';
    this.progressBar.appendChild(progressFill);
    
    // Status text
    this.statusText = document.createElement('span');
    this.statusText.textContent = '0%';
    
    // Assemble
    this.badge.appendChild(this.progressBar);
    this.badge.appendChild(this.statusText);
    
    // Create tooltip
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'context-badge-tooltip';
    this.badge.appendChild(this.tooltip);
    
    // Tooltip hover handled via CSS: .context-badge:hover .context-badge-tooltip { opacity: 1 }
    
    // Add to container
    this.container.appendChild(this.badge);
    
    if (this.enableLogging) {
      this.log.debug('[ContextBadge] Initialized');
    }
  }
  
  /**
   * Update badge with new status
   * @param {Object} status - Context status object
   */
  update(status) {
    if (!status) return;
    
    this.currentStatus = status;
    
    const usagePercent = status.usagePercent || status.usage_percent || 0;
    const tokenCount = status.tokenCount || status.token_count || 0;
    const tokenLimit = status.tokenLimit || status.token_limit || 50000;
    const statusLevel = status.status || 'normal';
    
    // Update progress bar
    const progressFill = this.progressBar.querySelector('.context-badge__fill');
    progressFill.style.width = `${Math.min(usagePercent, 100)}%`;
    
    // Update color based on status
    const colors = {
      new: 'var(--color-text-tertiary)',
      normal: 'var(--color-success)',
      warning: 'var(--color-warning)',
      high: 'var(--color-warning)',
      critical: 'var(--color-error)'
    };
    progressFill.style.background = colors[statusLevel] || colors.normal;
    
    // Update text
    this.statusText.textContent = `${Math.round(usagePercent)}%`;
    
    // Update tooltip
    const tooltipText = [
      `Tokens: ${tokenCount.toLocaleString()} / ${tokenLimit.toLocaleString()}`,
      `Status: ${statusLevel.toUpperCase()}`,
    ];
    
    if (status.recommendNewChat || status.recommend_new_chat) {
      tooltipText.push('Consider starting new chat');
    } else if (status.needsSummarization || status.needs_summarization) {
      tooltipText.push('Summarization available');
    }
    
    this.tooltip.textContent = tooltipText.join(' • ');
    
    if (this.enableLogging) {
      this.log.debug('[ContextBadge] Updated:', { usagePercent, statusLevel });
    }
  }
  
  /**
   * Hide badge
   */
  hide() {
    if (this.badge) {
      this.badge.style.display = 'none';
    }
  }
  
  /**
   * Show badge
   */
  show() {
    if (this.badge) {
      this.badge.style.display = 'inline-flex';
    }
  }
  
  /**
   * Cleanup
   */
  destroy() {
    if (this.badge && this.badge.parentNode) {
      this.badge.parentNode.removeChild(this.badge);
    }
    
    this.badge = null;
    this.progressBar = null;
    this.statusText = null;
    this.tooltip = null;
    
    if (this.enableLogging) {
      this.log.debug('[ContextBadge] Destroyed');
    }
  }
}

module.exports = { ContextBadge };
