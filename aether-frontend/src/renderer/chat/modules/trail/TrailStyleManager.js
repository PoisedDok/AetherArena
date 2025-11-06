'use strict';

/**
 * @.architecture
 * 
 * Incoming: Module initialization (init()) --- {method_call, javascript_api}
 * Processing: Inject CSS styles for trail containers into document head, ensure single injection via styleId tracking, provide cleanup --- {3 jobs: JOB_INITIALIZE, JOB_UPDATE_DOM_ELEMENT, JOB_DISPOSE}
 * Outgoing: document.head.appendChild() (CSS injection) --- {dom_types.style_element, html}
 * 
 * 
 * @module renderer/chat/modules/trail/TrailStyleManager
 * 
 * TrailStyleManager - CSS Injection for Trail Containers
 * ============================================================================
 * Manages CSS injection for artifact execution trails with proper lifecycle.
 */

class TrailStyleManager {
  constructor(options = {}) {
    this.styleId = options.styleId || 'artifact-trail-styles';
    this.injected = false;
  }
  
  /**
   * Inject CSS styles into document
   */
  inject() {
    if (this.injected || document.getElementById(this.styleId)) {
      return;
    }
    
    const style = document.createElement('style');
    style.id = this.styleId;
    style.textContent = this._getStyles();
    
    document.head.appendChild(style);
    this.injected = true;
    
    console.log('[TrailStyleManager] Styles injected');
  }
  
  /**
   * Remove injected styles
   */
  remove() {
    const existing = document.getElementById(this.styleId);
    if (existing) {
      existing.remove();
      this.injected = false;
      console.log('[TrailStyleManager] Styles removed');
    }
  }
  
  /**
   * Get CSS styles
   */
  _getStyles() {
    return `
      .artifact-execution-trail-container {
        margin: 8px 0;
        border-radius: 12px;
        background: rgba(15, 15, 15, 0.45);
        backdrop-filter: blur(24px) saturate(1.4);
        -webkit-backdrop-filter: blur(24px) saturate(1.4);
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        overflow: hidden;
        max-width: 100%;
        opacity: 1;
        position: relative;
        transition: height 0.5s cubic-bezier(0.2, 0, 0.2, 1), opacity 0.3s ease,
                    width 0.5s cubic-bezier(0.2, 0, 0.2, 1), box-shadow 0.3s ease, border-color 0.3s ease;
      }
      
      .artifact-execution-trail-container::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 12px;
        padding: 1px;
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, 
                                     rgba(255, 255, 255, 0.05) 50%, rgba(255, 255, 255, 0.02) 100%);
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        pointer-events: none;
        opacity: 0.6;
      }
      
      .artifact-execution-trail-container.animating {
        will-change: height, opacity, width;
      }
      
      .artifact-execution-trail-container[data-state="collapsed"] {
        height: 30px;
        width: 160px;
        opacity: 0.85;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(16px) saturate(1.2);
        -webkit-backdrop-filter: blur(16px) saturate(1.2);
      }
      
      .artifact-execution-trail-container[data-state="partial"] {
        height: 180px;
        width: 100%;
      }
      
      .artifact-execution-trail-container[data-state="expanded"] {
        height: auto;
        width: 100%;
        max-height: 70vh;
      }
      
      .trail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px;
        cursor: pointer;
        user-select: none;
        transition: background 0.2s ease;
      }
      
      .trail-header:hover {
        background: rgba(255, 255, 255, 0.06);
      }
      
      .artifact-execution-trail-container:hover {
        border-color: rgba(255, 255, 255, 0.2);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.12);
      }
      
      .trail-title {
        font-weight: 600;
        font-size: 13px;
        color: rgba(255, 255, 255, 0.85);
        letter-spacing: 0.3px;
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
      }
      
      .trail-time {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.5);
        font-weight: 500;
        margin-right: 8px;
        font-variant-numeric: tabular-nums;
      }
      
      .artifact-execution-trail-container[data-state="collapsed"] .trail-time {
        display: none;
      }
      
      .trail-status-icon {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .trail-status-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-top-color: rgba(255, 255, 255, 0.8);
        border-radius: 50%;
        animation: spinIndicator 1s linear infinite;
      }
      
      .trail-chevron {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: rgba(255, 255, 255, 0.6);
        transition: transform 0.45s cubic-bezier(0.2, 0, 0.2, 1);
      }
      
      .artifact-execution-trail-container[data-state="collapsed"] .trail-chevron {
        width: 18px;
        height: 18px;
      }
      
      .trail-chevron svg {
        transition: transform 0.45s cubic-bezier(0.2, 0, 0.2, 1);
      }
      
      .trail-chevron.rotate-0 { transform: rotate(0deg); }
      .trail-chevron.rotate-90 { transform: rotate(90deg); }
      .trail-chevron.rotate-180 { transform: rotate(180deg); }
      
      .trail-content-wrapper {
        height: 100%;
        overflow: auto;
        scrollbar-width: none;
        position: relative;
      }
      
      .trail-content-wrapper::-webkit-scrollbar {
        display: none;
      }
      
      .trail-content-wrapper::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.1) 50%, transparent 100%);
        pointer-events: none;
        z-index: 1;
      }
      
      .artifact-execution-trail-container[data-state="partial"] .trail-content-wrapper {
        mask-image: linear-gradient(to bottom, transparent 0px, black 30px, black 100%);
        -webkit-mask-image: linear-gradient(to bottom, transparent 0px, black 30px, black 100%);
      }
      
      .artifact-execution-trail-container[data-state="collapsed"] .trail-content-wrapper {
        display: none;
      }
      
      .trail-timeline {
        padding: 8px 12px 8px 40px;
        position: relative;
      }
      
      .artifact-execution-trail-container[data-state="collapsed"] .trail-timeline {
        display: none;
      }
      
      .trail-timeline::before {
        content: '';
        position: absolute;
        left: 24px;
        top: 0;
        bottom: 0;
        width: 2px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.08) 100%);
      }
      
      .execution-node-container {
        position: relative;
        margin-bottom: 8px;
      }
      
      .execution-node-container:last-child {
        margin-bottom: 0;
      }
      
      .execution-node {
        position: relative;
        padding: 8px 12px;
        margin-bottom: 4px;
        cursor: pointer;
        transition: all 0.2s ease;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid transparent;
      }
      
      .execution-node:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.1);
        transform: translateX(2px);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      }
      
      .execution-node:last-child {
        margin-bottom: 0;
      }
      
      .execution-node::before {
        content: '';
        position: absolute;
        left: -16px;
        top: 12px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: currentColor;
        box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.4);
        z-index: 1;
        transition: all 0.3s ease;
      }
      
      .execution-node.active {
        color: rgba(255, 255, 255, 0.9);
      }
      
      .execution-node.active::before {
        animation: nodePulse 2s ease-in-out infinite;
        box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.2);
      }
      
      .execution-node.completed {
        color: #10b981;
      }
      
      .execution-node.error {
        color: #ef4444;
      }
      
      .execution-node.pending {
        color: rgba(255, 255, 255, 0.5);
        opacity: 0.75;
      }
      
      .execution-node.pending::before {
        animation: nodePendingPulse 1.5s ease-in-out infinite;
      }
      
      .execution-node.non-clickable {
        cursor: default;
        opacity: 0.7;
      }
      
      .execution-node.non-clickable:hover {
        transform: none;
        background: rgba(255, 255, 255, 0.03);
      }
      
      @keyframes nodePulse {
        0%, 100% {
          transform: scale(1);
          box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.2);
        }
        50% {
          transform: scale(1.2);
          box-shadow: 0 0 0 6px rgba(255, 255, 255, 0.1);
        }
      }
      
      @keyframes nodePendingPulse {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 0.8; }
      }
      
      .node-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      
      .node-title {
        flex: 1;
        font-size: 12px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.9);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .node-time {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.4);
        font-variant-numeric: tabular-nums;
      }
      
      @keyframes fadeInSlideUp {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      
      @keyframes spinIndicator {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
  }
  
  /**
   * Cleanup
   */
  dispose() {
    this.remove();
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrailStyleManager;
}

if (typeof window !== 'undefined') {
  window.TrailStyleManager = TrailStyleManager;
  console.log('📦 TrailStyleManager loaded');
}

