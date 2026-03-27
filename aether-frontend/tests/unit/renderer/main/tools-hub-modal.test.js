'use strict';

// ---------------------------------------------------------------------------
// ToolsHubModal.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/modules/agents/components/ToolsHubModal.js (227 lines)
// Abstract base class extending BaseModal. Template Method pattern.
// Two-view architecture: ondemand | system. Tab navigation, view switching.
// BaseModal mocked to isolate ToolsHubModal's logic.
// ---------------------------------------------------------------------------

// Mock BaseModal — avoid DOM creation and event binding from base class
jest.mock(
  '../../../../src/renderer/shared/modals/BaseModal',
  () => class MockBaseModal {
    constructor(options = {}) {
      this.title = options.title || 'Modal';
      this.id = options.id || 'mock-modal';
      this.size = options.size || 'xl';
      this.isOpen = false;
    }
  }
);

const ToolsHubModal = require('../../../../src/renderer/main/modules/agents/components/ToolsHubModal');

// ---------------------------------------------------------------------------
// Concrete test subclass implementing all abstract methods
// ---------------------------------------------------------------------------

class TestHub extends ToolsHubModal {
  _getHubTitle() { return 'Test Hub Title'; }
  _getHubSubtitle() { return 'Test Hub Subtitle'; }
  _getViews() {
    return [
      { id: 'ondemand', label: 'On-Demand Tools' },
      { id: 'system', label: 'System Config' },
    ];
  }
  _renderOndemandView() { return '<div class="ondemand-content">On-demand view</div>'; }
  _renderSystemView() { return '<div class="system-content">System view</div>'; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHtml(htmlStr) {
  const container = document.createElement('div');
  container.innerHTML = htmlStr.trim();
  return container;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolsHubModal', () => {
  let hub;

  beforeEach(() => {
    hub = new TestHub({ title: 'Test Modal' });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('sets activeView to "ondemand" by default', () => {
      expect(hub.activeView).toBe('ondemand');
    });

    it('passes options to BaseModal super()', () => {
      expect(hub.title).toBe('Test Modal');
    });

    it('sets default title via BaseModal when not provided', () => {
      const h = new TestHub();
      expect(h.title).toBe('Modal');
    });

    it('accepts empty options', () => {
      const h = new TestHub({});
      expect(h.activeView).toBe('ondemand');
    });
  });

  // =========================================================================
  // _renderHub()
  // =========================================================================

  describe('_renderHub()', () => {
    it('returns HTML with agents-hub container', () => {
      const dom = parseHtml(hub._renderHub());
      expect(dom.querySelector('.agents-hub')).not.toBeNull();
    });

    it('renders hub title from _getHubTitle()', () => {
      const dom = parseHtml(hub._renderHub());
      const titleEl = dom.querySelector('.agents-hub-title');
      expect(titleEl).not.toBeNull();
      expect(titleEl.textContent).toBe('Test Hub Title');
    });

    it('renders hub subtitle from _getHubSubtitle()', () => {
      const dom = parseHtml(hub._renderHub());
      const subtitleEl = dom.querySelector('.agents-hub-subtitle');
      expect(subtitleEl).not.toBeNull();
      expect(subtitleEl.textContent).toBe('Test Hub Subtitle');
    });

    it('renders tab container with tablist role', () => {
      const dom = parseHtml(hub._renderHub());
      const tablist = dom.querySelector('[role="tablist"]');
      expect(tablist).not.toBeNull();
      expect(tablist.getAttribute('aria-label')).toBe('View tabs');
    });

    it('renders tabs from _getViews()', () => {
      const dom = parseHtml(hub._renderHub());
      const tabs = dom.querySelectorAll('[data-action="set-view"]');
      expect(tabs.length).toBe(2);
    });

    it('renders active view content in hub body', () => {
      const dom = parseHtml(hub._renderHub());
      const body = dom.querySelector('.agents-hub-body');
      expect(body).not.toBeNull();
      expect(body.querySelector('.ondemand-content')).not.toBeNull();
    });

    it('renders header and body sections', () => {
      const dom = parseHtml(hub._renderHub());
      expect(dom.querySelector('.agents-hub-header')).not.toBeNull();
      expect(dom.querySelector('.agents-hub-body')).not.toBeNull();
    });
  });

  // =========================================================================
  // _renderTabs()
  // =========================================================================

  describe('_renderTabs()', () => {
    it('renders a button for each view', () => {
      const dom = parseHtml(hub._renderTabs());
      const buttons = dom.querySelectorAll('button');
      expect(buttons.length).toBe(2);
    });

    it('marks active view tab with is-active class', () => {
      hub.activeView = 'ondemand';
      const dom = parseHtml(hub._renderTabs());
      const activeBtn = dom.querySelector('[data-view="ondemand"]');
      expect(activeBtn.classList.contains('is-active')).toBe(true);
    });

    it('does not mark inactive view tab with is-active class', () => {
      hub.activeView = 'ondemand';
      const dom = parseHtml(hub._renderTabs());
      const inactiveBtn = dom.querySelector('[data-view="system"]');
      expect(inactiveBtn.classList.contains('is-active')).toBe(false);
    });

    it('switches active class when activeView changes', () => {
      hub.activeView = 'system';
      const dom = parseHtml(hub._renderTabs());
      const systemBtn = dom.querySelector('[data-view="system"]');
      const ondemandBtn = dom.querySelector('[data-view="ondemand"]');
      expect(systemBtn.classList.contains('is-active')).toBe(true);
      expect(ondemandBtn.classList.contains('is-active')).toBe(false);
    });

    it('uses view.label as button text', () => {
      const dom = parseHtml(hub._renderTabs());
      const ondemandBtn = dom.querySelector('[data-view="ondemand"]');
      expect(ondemandBtn.textContent.trim()).toBe('On-Demand Tools');
    });

    it('falls back to view.id when label is missing', () => {
      class NoLabelHub extends ToolsHubModal {
        _getHubTitle() { return 'T'; }
        _getHubSubtitle() { return 'S'; }
        _getViews() { return [{ id: 'custom-view' }]; }
        _renderOndemandView() { return ''; }
        _renderSystemView() { return ''; }
      }
      const h = new NoLabelHub();
      h.activeView = 'custom-view';
      const dom = parseHtml(h._renderTabs());
      const btn = dom.querySelector('[data-view="custom-view"]');
      expect(btn.textContent.trim()).toBe('custom-view');
    });

    it('falls back to view.id when label is empty string', () => {
      class EmptyLabelHub extends ToolsHubModal {
        _getHubTitle() { return 'T'; }
        _getHubSubtitle() { return 'S'; }
        _getViews() { return [{ id: 'myview', label: '' }]; }
        _renderOndemandView() { return ''; }
        _renderSystemView() { return ''; }
      }
      const h = new EmptyLabelHub();
      h.activeView = 'myview';
      const dom = parseHtml(h._renderTabs());
      const btn = dom.querySelector('[data-view="myview"]');
      expect(btn.textContent.trim()).toBe('myview');
    });

    it('sets data-action="set-view" on each button', () => {
      const dom = parseHtml(hub._renderTabs());
      const buttons = dom.querySelectorAll('button');
      buttons.forEach(btn => {
        expect(btn.getAttribute('data-action')).toBe('set-view');
      });
    });

    it('sets data-view to the view id on each button', () => {
      const dom = parseHtml(hub._renderTabs());
      const ids = Array.from(dom.querySelectorAll('button')).map(
        b => b.getAttribute('data-view')
      );
      expect(ids).toEqual(['ondemand', 'system']);
    });

    it('applies btn-ghost btn-sm agents-tab classes to buttons', () => {
      const dom = parseHtml(hub._renderTabs());
      const btn = dom.querySelector('button');
      expect(btn.classList.contains('btn-ghost')).toBe(true);
      expect(btn.classList.contains('btn-sm')).toBe(true);
      expect(btn.classList.contains('agents-tab')).toBe(true);
    });

    it('renders empty string when no views defined', () => {
      class EmptyHub extends ToolsHubModal {
        _getHubTitle() { return 'T'; }
        _getHubSubtitle() { return 'S'; }
        _getViews() { return []; }
        _renderOndemandView() { return ''; }
        _renderSystemView() { return ''; }
      }
      const h = new EmptyHub();
      expect(h._renderTabs()).toBe('');
    });
  });

  // =========================================================================
  // _renderActiveView()
  // =========================================================================

  describe('_renderActiveView()', () => {
    it('returns ondemand view when activeView is "ondemand"', () => {
      hub.activeView = 'ondemand';
      const html = hub._renderActiveView();
      expect(html).toContain('ondemand-content');
      expect(html).toContain('On-demand view');
    });

    it('returns ondemand view when activeView is "tools" (legacy fallback)', () => {
      hub.activeView = 'tools';
      const html = hub._renderActiveView();
      expect(html).toContain('ondemand-content');
    });

    it('returns system view when activeView is "system"', () => {
      hub.activeView = 'system';
      const html = hub._renderActiveView();
      expect(html).toContain('system-content');
      expect(html).toContain('System view');
    });

    it('returns custom view for unknown activeView values', () => {
      hub.activeView = 'analytics';
      const html = hub._renderActiveView();
      expect(html).toContain('view-not-implemented');
      expect(html).toContain('analytics');
    });

    it('returns custom view for empty string activeView', () => {
      hub.activeView = '';
      const html = hub._renderActiveView();
      expect(html).toContain('view-not-implemented');
    });
  });

  // =========================================================================
  // _renderModalFooter()
  // =========================================================================

  describe('_renderModalFooter()', () => {
    it('returns Cancel and Save buttons for system view', () => {
      hub.activeView = 'system';
      const html = hub._renderModalFooter();
      const dom = parseHtml(html);
      expect(dom.querySelector('.agents-cancel')).not.toBeNull();
      expect(dom.querySelector('.agents-save')).not.toBeNull();
      expect(dom.querySelector('.agents-cancel').textContent).toBe('Cancel');
      expect(dom.querySelector('.agents-save').textContent).toBe('Save Changes');
    });

    it('Cancel button has btn-secondary class', () => {
      hub.activeView = 'system';
      const dom = parseHtml(hub._renderModalFooter());
      expect(dom.querySelector('.agents-cancel').classList.contains('btn-secondary')).toBe(true);
    });

    it('Save button has btn-primary class', () => {
      hub.activeView = 'system';
      const dom = parseHtml(hub._renderModalFooter());
      expect(dom.querySelector('.agents-save').classList.contains('btn-primary')).toBe(true);
    });

    it('returns empty string for ondemand view', () => {
      hub.activeView = 'ondemand';
      expect(hub._renderModalFooter()).toBe('');
    });

    it('returns empty string for tools view', () => {
      hub.activeView = 'tools';
      expect(hub._renderModalFooter()).toBe('');
    });

    it('returns empty string for custom view', () => {
      hub.activeView = 'analytics';
      expect(hub._renderModalFooter()).toBe('');
    });
  });

  // =========================================================================
  // switchView()
  // =========================================================================

  describe('switchView()', () => {
    it('switches to valid view and updates activeView', () => {
      hub.switchView('system');
      expect(hub.activeView).toBe('system');
    });

    it('switches back to ondemand from system', () => {
      hub.switchView('system');
      hub.switchView('ondemand');
      expect(hub.activeView).toBe('ondemand');
    });

    it('does nothing when viewId is null', () => {
      hub.switchView(null);
      expect(hub.activeView).toBe('ondemand');
    });

    it('does nothing when viewId is undefined', () => {
      hub.switchView(undefined);
      expect(hub.activeView).toBe('ondemand');
    });

    it('does nothing when viewId is empty string', () => {
      hub.switchView('');
      expect(hub.activeView).toBe('ondemand');
    });

    it('does nothing when viewId is 0 (falsy)', () => {
      hub.switchView(0);
      expect(hub.activeView).toBe('ondemand');
    });

    it('warns and does nothing for invalid viewId', () => {
      hub.logger = { warn: jest.fn() };
      hub.switchView('nonexistent');
      expect(hub.activeView).toBe('ondemand');
      expect(hub.logger.warn).toHaveBeenCalledWith(
        'ToolsHubModal: Invalid view ID: nonexistent'
      );
    });

    it('warns with exact view ID in message', () => {
      hub.logger = { warn: jest.fn() };
      hub.switchView('bad-view');
      expect(hub.logger.warn).toHaveBeenCalledWith(
        'ToolsHubModal: Invalid view ID: bad-view'
      );
    });

    it('does not throw when logger is undefined', () => {
      hub.logger = undefined;
      expect(() => hub.switchView('nonexistent')).not.toThrow();
    });

    it('does not throw when logger.warn is undefined', () => {
      hub.logger = {};
      expect(() => hub.switchView('nonexistent')).not.toThrow();
    });

    it('calls _onViewChanged after switching', () => {
      const spy = jest.fn();
      hub._onViewChanged = spy;
      hub.switchView('system');
      expect(spy).toHaveBeenCalledWith('system');
    });

    it('calls _onViewChanged with exact viewId', () => {
      const spy = jest.fn();
      hub._onViewChanged = spy;
      hub.switchView('ondemand');
      expect(spy).toHaveBeenCalledWith('ondemand');
    });

    it('does NOT call _onViewChanged for invalid view', () => {
      const spy = jest.fn();
      hub._onViewChanged = spy;
      hub.logger = { warn: jest.fn() };
      hub.switchView('nonexistent');
      expect(spy).not.toHaveBeenCalled();
    });

    it('does NOT call _onViewChanged for falsy viewId', () => {
      const spy = jest.fn();
      hub._onViewChanged = spy;
      hub.switchView(null);
      expect(spy).not.toHaveBeenCalled();
    });

    it('validates against _getViews() each time (dynamic)', () => {
      let views = [{ id: 'ondemand', label: 'A' }, { id: 'system', label: 'B' }];
      hub._getViews = () => views;

      hub.switchView('system');
      expect(hub.activeView).toBe('system');

      // Remove system from views
      views = [{ id: 'ondemand', label: 'A' }];
      hub.logger = { warn: jest.fn() };
      hub.switchView('system');
      // system is no longer valid
      expect(hub.logger.warn).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _onViewChanged()
  // =========================================================================

  describe('_onViewChanged()', () => {
    it('default implementation does not throw', () => {
      const rawHub = new ToolsHubModal();
      expect(() => rawHub._onViewChanged('system')).not.toThrow();
    });

    it('default implementation returns undefined', () => {
      const rawHub = new ToolsHubModal();
      expect(rawHub._onViewChanged('x')).toBeUndefined();
    });
  });

  // =========================================================================
  // Abstract methods (throw on base class)
  // =========================================================================

  describe('abstract methods', () => {
    let rawHub;

    beforeEach(() => {
      rawHub = new ToolsHubModal();
    });

    it('_getHubTitle() throws', () => {
      expect(() => rawHub._getHubTitle())
        .toThrow('ToolsHubModal: _getHubTitle() must be implemented by subclass');
    });

    it('_getHubSubtitle() throws', () => {
      expect(() => rawHub._getHubSubtitle())
        .toThrow('ToolsHubModal: _getHubSubtitle() must be implemented by subclass');
    });

    it('_getViews() throws', () => {
      expect(() => rawHub._getViews())
        .toThrow('ToolsHubModal: _getViews() must be implemented by subclass');
    });

    it('_renderOndemandView() throws', () => {
      expect(() => rawHub._renderOndemandView())
        .toThrow('ToolsHubModal: _renderOndemandView() must be implemented by subclass');
    });

    it('_renderSystemView() throws', () => {
      expect(() => rawHub._renderSystemView())
        .toThrow('ToolsHubModal: _renderSystemView() must be implemented by subclass');
    });

    it('_renderHub() throws when _getHubTitle is not implemented', () => {
      expect(() => rawHub._renderHub())
        .toThrow('_getHubTitle() must be implemented by subclass');
    });

    it('_renderActiveView() throws for ondemand when _renderOndemandView is not implemented', () => {
      rawHub.activeView = 'ondemand';
      expect(() => rawHub._renderActiveView())
        .toThrow('_renderOndemandView() must be implemented by subclass');
    });

    it('_renderActiveView() throws for system when _renderSystemView is not implemented', () => {
      rawHub.activeView = 'system';
      expect(() => rawHub._renderActiveView())
        .toThrow('_renderSystemView() must be implemented by subclass');
    });
  });

  // =========================================================================
  // _renderToolsView() (legacy)
  // =========================================================================

  describe('_renderToolsView()', () => {
    it('delegates to _renderOndemandView()', () => {
      const result = hub._renderToolsView();
      expect(result).toContain('ondemand-content');
    });

    it('returns same result as _renderOndemandView()', () => {
      expect(hub._renderToolsView()).toBe(hub._renderOndemandView());
    });
  });

  // =========================================================================
  // _renderCustomView()
  // =========================================================================

  describe('_renderCustomView()', () => {
    it('returns "not implemented" message with viewId', () => {
      const html = hub._renderCustomView('analytics');
      const dom = parseHtml(html);
      const el = dom.querySelector('.view-not-implemented');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('analytics');
    });

    it('includes "not implemented" text', () => {
      const html = hub._renderCustomView('reports');
      expect(html).toContain('not implemented');
      expect(html).toContain('reports');
    });

    it('handles empty string viewId', () => {
      const html = hub._renderCustomView('');
      expect(html).toContain('view-not-implemented');
    });
  });

  // =========================================================================
  // Integration: view switching affects rendering
  // =========================================================================

  describe('integration: view switching affects rendering', () => {
    it('_renderHub shows ondemand content initially', () => {
      const dom = parseHtml(hub._renderHub());
      expect(dom.querySelector('.ondemand-content')).not.toBeNull();
      expect(dom.querySelector('.system-content')).toBeNull();
    });

    it('_renderHub shows system content after switchView("system")', () => {
      hub.switchView('system');
      const dom = parseHtml(hub._renderHub());
      expect(dom.querySelector('.system-content')).not.toBeNull();
      expect(dom.querySelector('.ondemand-content')).toBeNull();
    });

    it('_renderModalFooter changes based on active view', () => {
      expect(hub._renderModalFooter()).toBe('');
      hub.switchView('system');
      expect(hub._renderModalFooter()).not.toBe('');
      hub.switchView('ondemand');
      expect(hub._renderModalFooter()).toBe('');
    });

    it('tabs reflect active view after switch', () => {
      hub.switchView('system');
      const dom = parseHtml(hub._renderTabs());
      expect(dom.querySelector('[data-view="system"]').classList.contains('is-active')).toBe(true);
      expect(dom.querySelector('[data-view="ondemand"]').classList.contains('is-active')).toBe(false);
    });

    it('_renderActiveView falls through to custom view for unmatched activeView', () => {
      hub.activeView = 'custom-thing';
      const html = hub._renderActiveView();
      expect(html).toContain('view-not-implemented');
      expect(html).toContain('custom-thing');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('activeView can be set directly (no validation)', () => {
      hub.activeView = 'arbitrary';
      expect(hub.activeView).toBe('arbitrary');
    });

    it('_renderTabs handles views with only id (no label property)', () => {
      class IdOnlyHub extends ToolsHubModal {
        _getHubTitle() { return 'T'; }
        _getHubSubtitle() { return 'S'; }
        _getViews() { return [{ id: 'alpha' }, { id: 'beta' }]; }
        _renderOndemandView() { return ''; }
        _renderSystemView() { return ''; }
      }
      const h = new IdOnlyHub();
      const dom = parseHtml(h._renderTabs());
      const buttons = dom.querySelectorAll('button');
      expect(buttons[0].textContent.trim()).toBe('alpha');
      expect(buttons[1].textContent.trim()).toBe('beta');
    });

    it('switchView does not mutate _getViews() return value', () => {
      const viewsBefore = JSON.parse(JSON.stringify(hub._getViews()));
      hub.switchView('system');
      const viewsAfter = hub._getViews();
      expect(viewsAfter).toEqual(viewsBefore);
    });

    it('_renderActiveView with "tools" calls same path as "ondemand"', () => {
      hub.activeView = 'tools';
      const toolsHtml = hub._renderActiveView();
      hub.activeView = 'ondemand';
      const ondemandHtml = hub._renderActiveView();
      expect(toolsHtml).toBe(ondemandHtml);
    });

    it('multiple views with same active state renders correctly', () => {
      class MultiHub extends ToolsHubModal {
        _getHubTitle() { return 'T'; }
        _getHubSubtitle() { return 'S'; }
        _getViews() {
          return [
            { id: 'ondemand', label: 'A' },
            { id: 'system', label: 'B' },
            { id: 'extra', label: 'C' },
          ];
        }
        _renderOndemandView() { return 'OD'; }
        _renderSystemView() { return 'SYS'; }
      }
      const h = new MultiHub();
      const dom = parseHtml(h._renderTabs());
      expect(dom.querySelectorAll('button').length).toBe(3);
      const activeButtons = dom.querySelectorAll('.is-active');
      expect(activeButtons.length).toBe(1);
    });
  });
});
