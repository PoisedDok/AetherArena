/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

const ServiceStatusBinder = require('../../../../../src/application/main/modules/settings/binders/ServiceStatusBinder');

/**
 * Helper: build the service-status-grid DOM container.
 */
function buildStatusDom() {
  document.body.innerHTML = '<div id="service-status-grid"></div>';
}

describe('ServiceStatusBinder', () => {
  let binder;
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const mockEndpoint = { getServicesStatus: jest.fn() };

  beforeEach(() => {
    binder = new ServiceStatusBinder({ log: mockLog, endpoint: mockEndpoint });
    mockEndpoint.getServicesStatus.mockReset();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });
  afterEach(() => { document.body.innerHTML = ''; });

  // --- Container missing ---

  describe('missing container', () => {
    it('logs warning and returns when container absent', async () => {
      // no DOM at all
      await binder.load();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('container not found'));
      expect(mockEndpoint.getServicesStatus).not.toHaveBeenCalled();
    });
  });

  // --- Contract violations ---

  describe('contract violations', () => {
    it('throws and renders error when endpoint missing', async () => {
      buildStatusDom();
      const noEndpointBinder = new ServiceStatusBinder({ log: mockLog, endpoint: null });
      await noEndpointBinder.load();
      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load'), expect.any(Error));
      expect(document.getElementById('service-status-grid').innerHTML).toContain('Error loading services');
    });

    it('throws and renders error when payload has no services array', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ bad: true });
      await binder.load();
      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load'), expect.any(Error));
      expect(document.getElementById('service-status-grid').innerHTML).toContain('Error loading services');
    });

    it('throws when endpoint.getServicesStatus is not a function', async () => {
      buildStatusDom();
      const badBinder = new ServiceStatusBinder({ log: mockLog, endpoint: { getServicesStatus: 'not-a-fn' } });
      await badBinder.load();
      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load'), expect.any(Error));
    });
  });

  // --- Empty services ---

  describe('empty services', () => {
    it('renders "No services configured" message', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [] });
      await binder.load();
      const container = document.getElementById('service-status-grid');
      expect(container.innerHTML).toContain('No services configured');
      expect(container.querySelectorAll('.service-card').length).toBe(0);
    });
  });

  // --- Online service card ---

  describe('online service card', () => {
    const onlineSvc = { name: 'aether', status: 'online', url: 'http://localhost:8765', port: 8765, description: 'Main service' };

    beforeEach(async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [onlineSvc] });
      await binder.load();
    });

    it('renders one card', () => {
      expect(document.querySelectorAll('.service-card').length).toBe(1);
    });

    it('applies status-online class', () => {
      const card = document.querySelector('.service-card');
      expect(card.classList.contains('status-online')).toBe(true);
    });

    it('displays service name uppercased', () => {
      expect(document.querySelector('.service-name').textContent).toBe('AETHER');
    });

    it('displays URL', () => {
      expect(document.querySelector('.service-url').textContent).toBe('http://localhost:8765');
    });

    it('renders badge-success badge with "Online" label', () => {
      const badge = document.querySelector('.service-badge');
      expect(badge.classList.contains('badge-success')).toBe(true);
      expect(badge.textContent).toBe('Online');
    });

    it('displays port', () => {
      expect(document.querySelector('.service-port').textContent).toContain('8765');
    });

    it('renders description in service-meta', () => {
      const meta = document.querySelector('.service-meta');
      expect(meta).not.toBeNull();
      expect(meta.textContent).toContain('Main service');
    });

    it('sets data-service attribute', () => {
      expect(document.querySelector('.service-card').dataset.service).toBe('aether');
    });
  });

  // --- Offline service card ---

  describe('offline service card', () => {
    const offlineSvc = { name: 'perplexica', status: 'offline', url: null, port: null, error: 'Connection refused' };

    beforeEach(async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [offlineSvc] });
      await binder.load();
    });

    it('applies status-offline class', () => {
      expect(document.querySelector('.service-card').classList.contains('status-offline')).toBe(true);
    });

    it('renders badge-error badge', () => {
      const badge = document.querySelector('.service-badge');
      expect(badge.classList.contains('badge-error')).toBe(true);
      expect(badge.textContent).toBe('offline');
    });

    it('shows fallback URL text', () => {
      expect(document.querySelector('.service-url').textContent).toBe('On-demand / in-process');
    });

    it('shows em dash for null port', () => {
      expect(document.querySelector('.service-port').textContent).toContain('\u2014');
    });

    it('renders error in service-meta', () => {
      expect(document.querySelector('.service-meta').textContent).toContain('Connection refused');
    });
  });

  // --- Degraded service card ---

  describe('degraded service card', () => {
    const degradedSvc = { name: 'searxng', status: 'degraded', url: 'http://localhost:4000', port: 4000 };

    beforeEach(async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [degradedSvc] });
      await binder.load();
    });

    it('applies status-offline class (degraded is not online or on_demand)', () => {
      expect(document.querySelector('.service-card').classList.contains('status-offline')).toBe(true);
    });

    it('renders badge-warning badge with "Degraded" label', () => {
      const badge = document.querySelector('.service-badge');
      expect(badge.classList.contains('badge-warning')).toBe(true);
      expect(badge.textContent).toBe('Degraded');
    });
  });

  // --- On-demand service card ---

  describe('on_demand service card', () => {
    const onDemandSvc = { name: 'kokoro', status: 'on_demand', url: null, port: null, description: 'TTS engine' };

    beforeEach(async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [onDemandSvc] });
      await binder.load();
    });

    it('applies status-ondemand class', () => {
      expect(document.querySelector('.service-card').classList.contains('status-ondemand')).toBe(true);
    });

    it('renders badge-info badge with "On Demand" label', () => {
      const badge = document.querySelector('.service-badge');
      expect(badge.classList.contains('badge-info')).toBe(true);
      expect(badge.textContent).toBe('On Demand');
    });
  });

  // --- Multiple services ---

  describe('multiple services', () => {
    it('renders one card per service', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({
        services: [
          { name: 'a', status: 'online', url: 'http://a', port: 1 },
          { name: 'b', status: 'offline', url: null, port: null },
          { name: 'c', status: 'on_demand', url: null, port: null },
        ],
      });
      await binder.load();
      expect(document.querySelectorAll('.service-card').length).toBe(3);
    });
  });

  // --- Refresh button wiring ---

  describe('refresh button', () => {
    it('calls load() again when clicked', async () => {
      buildStatusDom();
      const svc = { name: 'test', status: 'online', url: 'http://x', port: 1 };
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });
      await binder.load();
      expect(mockEndpoint.getServicesStatus).toHaveBeenCalledTimes(1);

      // Click the refresh button
      const refreshBtn = document.querySelector('.service-health-btn[data-action="refresh-services"]');
      expect(refreshBtn).not.toBeNull();
      // Listener is tracked in binder._listeners, not via dataset flag
      expect(binder._listeners.length).toBe(1);

      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });
      refreshBtn.click();

      // Wait for async load() to complete
      await new Promise(r => setTimeout(r, 0));
      expect(mockEndpoint.getServicesStatus).toHaveBeenCalledTimes(2);
    });

    it('does not double-wire listener on second load()', async () => {
      buildStatusDom();
      const svc = { name: 'x', status: 'online', url: 'http://x', port: 1 };
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });

      // Load twice -- _clearTrackedListeners removes old before adding new
      await binder.load();
      expect(binder._listeners.length).toBe(1);

      await binder.load();
      expect(binder._listeners.length).toBe(1);

      expect(mockEndpoint.getServicesStatus).toHaveBeenCalledTimes(2);
    });
  });

  // --- Error state ---

  describe('error state', () => {
    it('renders error message when endpoint rejects', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockRejectedValue(new Error('network fail'));
      await binder.load();
      expect(document.getElementById('service-status-grid').innerHTML).toContain('Error loading services');
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // --- enableLogging ---

  describe('enableLogging', () => {
    it('logs info when enabled', async () => {
      buildStatusDom();
      binder.enableLogging = true;
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [{ name: 'a', status: 'online', url: 'http://a', port: 1 }] });
      await binder.load();
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('Services status loaded'));
    });

    it('does not log when disabled', async () => {
      buildStatusDom();
      binder.enableLogging = false;
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [{ name: 'a', status: 'online', url: 'http://a', port: 1 }] });
      await binder.load();
      expect(mockLog.info).not.toHaveBeenCalled();
    });
  });

  // --- Edge: unknown status ---

  describe('unknown status', () => {
    it('renders raw status with underscores replaced by spaces', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [{ name: 'foo', status: 'some_weird_state', url: null, port: null }] });
      await binder.load();
      const badge = document.querySelector('.service-badge');
      expect(badge.textContent).toBe('some weird state');
      expect(badge.classList.contains('badge-error')).toBe(true);
    });
  });

  // --- Edge: description + error combined ---

  describe('description and error combined', () => {
    it('renders both separated by bullet', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({
        services: [{ name: 'svc', status: 'degraded', url: 'http://x', port: 1, description: 'Search', error: 'Slow' }],
      });
      await binder.load();
      const meta = document.querySelector('.service-meta');
      expect(meta.textContent).toContain('Search');
      expect(meta.textContent).toContain('Slow');
      // Bullet separator between
      expect(meta.textContent).toContain('\u2022');
    });
  });

  // --- Edge: no description, no error ---

  describe('no description and no error', () => {
    it('does not render service-meta element', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({
        services: [{ name: 'clean', status: 'online', url: 'http://x', port: 1 }],
      });
      await binder.load();
      expect(document.querySelector('.service-meta')).toBeNull();
    });
  });

  // --- Memory Leak Detection ---

  describe('lifecycle: listener tracking and cleanup', () => {
    const svc = { name: 'test', status: 'online', url: 'http://x', port: 1 };

    it('tracks listeners after load()', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });
      await binder.load();
      // 1 service card = 1 refresh button = 1 tracked listener
      expect(binder._listeners.length).toBe(1);
      expect(binder._listeners[0].event).toBe('click');
    });

    it('clears old listeners before re-rendering on subsequent load()', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });

      await binder.load();
      expect(binder._listeners.length).toBe(1);
      const firstListener = binder._listeners[0];

      await binder.load();
      expect(binder._listeners.length).toBe(1);
      // The tracked listener should be a NEW one (old was removed)
      expect(binder._listeners[0]).not.toBe(firstListener);
    });

    it('listener count stays constant after N load() calls', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });

      for (let i = 0; i < 5; i++) {
        await binder.load();
      }
      // Should still be exactly 1, not 5
      expect(binder._listeners.length).toBe(1);
    });

    it('tracks N listeners for N service cards', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({
        services: [
          { name: 'a', status: 'online', url: 'http://a', port: 1 },
          { name: 'b', status: 'offline', url: null, port: null },
          { name: 'c', status: 'on_demand', url: null, port: null },
        ],
      });
      await binder.load();
      expect(binder._listeners.length).toBe(3);
    });

    it('clears listeners when services become empty', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });
      await binder.load();
      expect(binder._listeners.length).toBe(1);

      // Load again with empty services
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [] });
      await binder.load();
      expect(binder._listeners.length).toBe(0);
    });

    it('clears listeners on error path', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });
      await binder.load();
      expect(binder._listeners.length).toBe(1);

      // Load again with error
      mockEndpoint.getServicesStatus.mockRejectedValue(new Error('fail'));
      await binder.load();
      expect(binder._listeners.length).toBe(0);
    });

    it('dispose() removes all tracked listeners and sets disposed flag', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });
      await binder.load();
      expect(binder._listeners.length).toBe(1);
      expect(binder._isDisposed).toBe(false);

      binder.dispose();

      expect(binder._listeners.length).toBe(0);
      expect(binder._endpoint).toBeNull();
      expect(binder._isDisposed).toBe(true);
    });

    it('dispose() is idempotent (double-dispose safe)', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });
      await binder.load();

      binder.dispose();
      expect(binder._isDisposed).toBe(true);

      // Second dispose should not throw
      expect(() => binder.dispose()).not.toThrow();
      expect(binder._isDisposed).toBe(true);
    });

    it('dispose() calls removeEventListener on all tracked elements', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({ services: [svc] });
      await binder.load();

      const trackedEntry = binder._listeners[0];
      const spy = jest.spyOn(trackedEntry.element, 'removeEventListener');

      binder.dispose();

      expect(spy).toHaveBeenCalledWith('click', trackedEntry.handler);
      spy.mockRestore();
    });

    it('quantitative: N created = M cleaned across full lifecycle', async () => {
      buildStatusDom();
      mockEndpoint.getServicesStatus.mockResolvedValue({
        services: [
          { name: 'a', status: 'online', url: 'http://a', port: 1 },
          { name: 'b', status: 'offline', url: null, port: null },
        ],
      });

      // Track all removeEventListener calls
      const removeCalls = [];
      const origRemove = HTMLElement.prototype.removeEventListener;
      HTMLElement.prototype.removeEventListener = function(evt, fn, opts) {
        removeCalls.push({ element: this, event: evt, handler: fn });
        return origRemove.call(this, evt, fn, opts);
      };

      try {
        // Load 1: creates 2 listeners
        await binder.load();
        expect(binder._listeners.length).toBe(2);

        // Load 2: clears 2, creates 2
        await binder.load();
        expect(removeCalls.length).toBe(2);

        // Dispose: clears remaining 2
        binder.dispose();
        expect(removeCalls.length).toBe(4);
        // Total: 4 created (2 + 2), 4 removed (2 + 2). N = M.
      } finally {
        HTMLElement.prototype.removeEventListener = origRemove;
      }
    });
  });
});
