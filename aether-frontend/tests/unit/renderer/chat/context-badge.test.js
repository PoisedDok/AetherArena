'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const { ContextBadge } = require(
  '../../../../src/renderer/chat/components/ContextBadge'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function createBadge(overrides = {}) {
  const container = overrides.container || createContainer();
  return new ContextBadge({ container, ...overrides });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextBadge', () => {
  let badge;
  let container;

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    container = createContainer();
  });

  afterEach(() => {
    if (badge) {
      try { badge.destroy(); } catch (e) { /* noop */ }
      badge = null;
    }
    // Cleanup container from body
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('throws when container not provided', () => {
      expect(() => new ContextBadge()).toThrow('[ContextBadge] container required');
    });

    it('throws when container is null', () => {
      expect(() => new ContextBadge({ container: null })).toThrow('[ContextBadge] container required');
    });

    it('creates badge DOM and appends to container', () => {
      badge = createBadge({ container });
      expect(container.querySelector('.context-badge')).toBeDefined();
      expect(container.querySelector('.context-badge')).not.toBeNull();
    });

    it('initializes currentStatus to null', () => {
      badge = createBadge({ container });
      expect(badge.currentStatus).toBeNull();
    });

    it('sets enableLogging from options', () => {
      badge = createBadge({ container, enableLogging: true });
      expect(badge.enableLogging).toBe(true);
    });

    it('defaults enableLogging to false', () => {
      badge = createBadge({ container });
      expect(badge.enableLogging).toBeFalsy();
    });

    it('creates progress bar element', () => {
      badge = createBadge({ container });
      expect(badge.progressBar).toBeDefined();
      expect(badge.progressBar.classList.contains('context-badge__progress')).toBe(true);
    });

    it('creates status text element with initial 0%', () => {
      badge = createBadge({ container });
      expect(badge.statusText.textContent).toBe('0%');
    });

    it('creates tooltip element', () => {
      badge = createBadge({ container });
      expect(badge.tooltip).toBeDefined();
      expect(badge.tooltip.classList.contains('context-badge-tooltip')).toBe(true);
    });

    it('sets role=status for accessibility', () => {
      badge = createBadge({ container });
      expect(badge.badge.getAttribute('role')).toBe('status');
    });

    it('sets aria-label', () => {
      badge = createBadge({ container });
      expect(badge.badge.getAttribute('aria-label')).toBe('Context usage indicator');
    });

    it('logs debug when enableLogging is true', () => {
      badge = createBadge({ container, enableLogging: true });
      expect(mockLog.debug).toHaveBeenCalledWith('[ContextBadge] Initialized');
    });

    it('does not log debug when enableLogging is false', () => {
      badge = createBadge({ container });
      expect(mockLog.debug).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // update
  // =========================================================================

  describe('update', () => {
    beforeEach(() => {
      badge = createBadge({ container });
    });

    it('no-ops when status is null', () => {
      badge.update(null);
      expect(badge.currentStatus).toBeNull();
    });

    it('no-ops when status is undefined', () => {
      badge.update(undefined);
      expect(badge.currentStatus).toBeNull();
    });

    it('stores currentStatus', () => {
      const status = { usagePercent: 42, status: 'normal' };
      badge.update(status);
      expect(badge.currentStatus).toBe(status);
    });

    it('reads camelCase fields', () => {
      badge.update({ usagePercent: 42, tokenCount: 4200, tokenLimit: 10000, status: 'normal' });
      expect(badge.statusText.textContent).toBe('42%');
    });

    it('reads snake_case fields', () => {
      badge.update({ usage_percent: 55, token_count: 5500, token_limit: 10000, status: 'warning' });
      expect(badge.statusText.textContent).toBe('55%');
    });

    it('defaults tokenLimit to 50000 when not provided', () => {
      badge.update({ usage_percent: 20, token_count: 1000, status: 'normal' });
      expect(badge.tooltip.textContent).toContain('50,000');
    });

    it('rounds percentage in text display', () => {
      badge.update({ usagePercent: 42.7, status: 'normal' });
      expect(badge.statusText.textContent).toBe('43%');
    });

    it('caps progress bar width at 100%', () => {
      badge.update({ usagePercent: 120, status: 'critical' });
      const fill = badge.progressBar.querySelector('.context-badge__fill');
      expect(fill.style.width).toBe('100%');
    });

    it('sets progress bar width to usage percent', () => {
      badge.update({ usagePercent: 42, status: 'normal' });
      const fill = badge.progressBar.querySelector('.context-badge__fill');
      expect(fill.style.width).toBe('42%');
    });

    it('builds tooltip with token counts', () => {
      badge.update({
        usagePercent: 42,
        tokenCount: 4200,
        tokenLimit: 10000,
        status: 'normal'
      });
      expect(badge.tooltip.textContent).toContain('4,200');
      expect(badge.tooltip.textContent).toContain('10,000');
      expect(badge.tooltip.textContent).toContain('NORMAL');
    });

    it('adds "Consider starting new chat" for recommendNewChat', () => {
      badge.update({
        usagePercent: 95,
        status: 'critical',
        recommendNewChat: true
      });
      expect(badge.tooltip.textContent).toContain('Consider starting new chat');
    });

    it('adds "Consider starting new chat" for recommend_new_chat (snake_case)', () => {
      badge.update({
        usagePercent: 95,
        status: 'critical',
        recommend_new_chat: true
      });
      expect(badge.tooltip.textContent).toContain('Consider starting new chat');
    });

    it('adds "Summarization available" for needsSummarization', () => {
      badge.update({
        usagePercent: 80,
        status: 'warning',
        needsSummarization: true
      });
      expect(badge.tooltip.textContent).toContain('Summarization available');
    });

    it('adds "Summarization available" for needs_summarization (snake_case)', () => {
      badge.update({
        usagePercent: 80,
        status: 'warning',
        needs_summarization: true
      });
      expect(badge.tooltip.textContent).toContain('Summarization available');
    });

    it('uses fallback color for unknown status level', () => {
      badge.update({ usagePercent: 42, status: 'unknown_level' });
      // Falls back to colors.normal, no error thrown
      expect(badge.statusText.textContent).toBe('42%');
    });

    it('handles status level "new"', () => {
      badge.update({ usagePercent: 0, status: 'new' });
      expect(badge.statusText.textContent).toBe('0%');
    });

    it('handles status level "high"', () => {
      badge.update({ usagePercent: 92, status: 'high' });
      expect(badge.tooltip.textContent).toContain('HIGH');
    });

    it('logs debug when enableLogging is true', () => {
      badge.destroy();
      badge = createBadge({ container, enableLogging: true });
      mockLog.debug.mockClear();
      badge.update({ usagePercent: 50, status: 'normal' });
      expect(mockLog.debug).toHaveBeenCalledWith(
        '[ContextBadge] Updated:',
        { usagePercent: 50, statusLevel: 'normal' }
      );
    });

    it('defaults status to normal when not provided', () => {
      badge.update({ usagePercent: 50 });
      expect(badge.tooltip.textContent).toContain('NORMAL');
    });
  });

  // =========================================================================
  // hide / show
  // =========================================================================

  describe('hide', () => {
    it('sets display to none', () => {
      badge = createBadge({ container });
      badge.hide();
      expect(badge.badge.style.display).toBe('none');
    });

    it('is safe when badge is null', () => {
      badge = createBadge({ container });
      badge.badge = null;
      expect(() => badge.hide()).not.toThrow();
    });
  });

  describe('show', () => {
    it('sets display to inline-flex', () => {
      badge = createBadge({ container });
      badge.hide();
      badge.show();
      expect(badge.badge.style.display).toBe('inline-flex');
    });

    it('is safe when badge is null', () => {
      badge = createBadge({ container });
      badge.badge = null;
      expect(() => badge.show()).not.toThrow();
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================

  describe('destroy', () => {
    it('removes badge from container', () => {
      badge = createBadge({ container });
      expect(container.querySelector('.context-badge')).not.toBeNull();
      badge.destroy();
      expect(container.querySelector('.context-badge')).toBeNull();
    });

    it('nulls all DOM references', () => {
      badge = createBadge({ container });
      badge.destroy();
      expect(badge.badge).toBeNull();
      expect(badge.progressBar).toBeNull();
      expect(badge.statusText).toBeNull();
      expect(badge.tooltip).toBeNull();
    });

    it('is safe when badge has no parent', () => {
      badge = createBadge({ container });
      // Remove badge from DOM manually first
      if (badge.badge.parentNode) {
        badge.badge.parentNode.removeChild(badge.badge);
      }
      expect(() => badge.destroy()).not.toThrow();
    });

    it('logs when enableLogging is true', () => {
      badge = createBadge({ container, enableLogging: true });
      mockLog.debug.mockClear();
      badge.destroy();
      expect(mockLog.debug).toHaveBeenCalledWith('[ContextBadge] Destroyed');
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('create -> update -> hide -> show -> destroy', () => {
      badge = createBadge({ container });
      badge.update({ usagePercent: 50, tokenCount: 5000, tokenLimit: 10000, status: 'normal' });
      expect(badge.statusText.textContent).toBe('50%');

      badge.hide();
      expect(badge.badge.style.display).toBe('none');

      badge.show();
      expect(badge.badge.style.display).toBe('inline-flex');

      badge.destroy();
      expect(badge.badge).toBeNull();
    });
  });
});
