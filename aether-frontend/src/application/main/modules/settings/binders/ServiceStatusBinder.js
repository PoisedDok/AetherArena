'use strict';

/**
 * @.architecture
 * Incoming: SettingsManager delegation for service status display --- {endpoint, javascript_object}
 * Processing: Fetch service statuses from backend, render status cards via innerHTML, wire refresh buttons --- {2 jobs: JOB_HTTP_REQUEST, JOB_DOM_RENDER}
 * Outgoing: DOM mutations (service-status-grid innerHTML), endpoint.getServicesStatus() --- {dom_mutation | http_request, void}
 *
 * @module application/main/modules/settings/binders/ServiceStatusBinder
 */

class ServiceStatusBinder {
  constructor(deps = {}) {
    this._log = deps.log || { info() {}, warn() {}, error() {} };
    this._endpoint = deps.endpoint || null;
    this._enableLogging = false;
    this._listeners = [];
    this._isDisposed = false;
  }

  /**
   * Remove all tracked DOM listeners and release references.
   */
  dispose() {
    if (this._isDisposed) return;
    for (const { element, event, handler } of this._listeners) {
      element?.removeEventListener(event, handler);
    }
    this._listeners = [];
    this._endpoint = null;
    this._isDisposed = true;
  }

  /**
   * Track a DOM event listener for cleanup.
   * @param {Element} element
   * @param {string} event
   * @param {Function} handler
   * @private
   */
  _trackListener(element, event, handler) {
    element.addEventListener(event, handler);
    this._listeners.push({ element, event, handler });
  }

  /**
   * Remove all currently tracked listeners (called before innerHTML replacement).
   * @private
   */
  _clearTrackedListeners() {
    for (const { element, event, handler } of this._listeners) {
      element?.removeEventListener(event, handler);
    }
    this._listeners = [];
  }

  set enableLogging(v) { this._enableLogging = v; }

  /**
   * Load and render service statuses into the service-status-grid container.
   * CONTRACT: endpoint.getServicesStatus() must return { services: Array }.
   * @returns {Promise<void>}
   */
  async load() {
    try {
      const servicesContainer = document.getElementById('service-status-grid');

      if (!servicesContainer) {
        this._log.warn('[ServiceStatusBinder] Service status container not found');
        return;
      }

      if (!this._endpoint || typeof this._endpoint.getServicesStatus !== 'function') {
        throw new Error('[ServiceStatusBinder] CONTRACT VIOLATION: endpoint.getServicesStatus() is required');
      }

      const payload = await this._endpoint.getServicesStatus();
      const services = Array.isArray(payload?.services) ? payload.services : null;
      if (!services) {
        throw new Error('[ServiceStatusBinder] CONTRACT VIOLATION: /v1/services/status returned invalid payload');
      }

      if (services.length === 0) {
        this._clearTrackedListeners();
        servicesContainer.innerHTML = '<div class="service-empty-state">No services configured.</div>';
        return;
      }

      // Remove listeners from previous DOM before replacing
      this._clearTrackedListeners();

      servicesContainer.innerHTML = services.map(svc => this._renderCard(svc)).join('');

      // Refresh handler (re-fetches authoritative backend status)
      const refreshButtons = servicesContainer.querySelectorAll('.service-health-btn[data-action="refresh-services"]');
      refreshButtons.forEach((btn) => {
        const handler = (e) => {
          e.stopPropagation();
          this.load().catch((err) => {
            this._log.error('[ServiceStatusBinder] Failed to refresh services:', err);
          });
        };
        this._trackListener(btn, 'click', handler);
      });

      if (this._enableLogging) {
        this._log.info('[ServiceStatusBinder] Services status loaded');
      }
    } catch (error) {
      this._log.error('[ServiceStatusBinder] Failed to load services status:', error);
      this._clearTrackedListeners();
      const servicesContainer = document.getElementById('service-status-grid');
      if (servicesContainer) {
        servicesContainer.innerHTML = '<div class="service-empty-state">Error loading services</div>';
      }
    }
  }

  /**
   * Render a single service card HTML string.
   * @param {Object} svc - Service object from backend
   * @returns {string} HTML string
   * @private
   */
  _renderCard(svc) {
    const rawStatus = String(svc?.status || 'unknown').toLowerCase();
    const isOnline = rawStatus === 'online';
    const isDegraded = rawStatus === 'degraded';
    const isOnDemand = rawStatus === 'on_demand';

    const cardClass = isOnline ? 'status-online' : (isOnDemand ? 'status-ondemand' : 'status-offline');
    const badgeClass = isOnline ? 'badge-success' : (isDegraded ? 'badge-warning' : (isOnDemand ? 'badge-info' : 'badge-error'));
    const statusLabel = isOnline ? 'Online' : (isOnDemand ? 'On Demand' : (isDegraded ? 'Degraded' : rawStatus.replace(/_/g, ' ')));

    const urlText = svc?.url ? String(svc.url) : 'On-demand / in-process';
    const portText = (svc?.port !== null && svc?.port !== undefined) ? String(svc.port) : '\u2014';
    const statusColor = isOnline ? 'var(--color-success)' : (isDegraded ? 'var(--color-warning)' : 'var(--color-error)');

    const error = svc?.error ? String(svc.error) : '';
    const description = svc?.description ? String(svc.description) : '';

    return `
      <div class="service-card ${cardClass}" data-service="${String(svc?.name || '')}">
        <div class="service-card-header">
          <div class="service-icon">
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
              <rect x="2" y="2" width="40" height="40" rx="12" fill="var(--color-surface-base)" stroke="var(--color-border-base)" stroke-width="1.5"/>
              <circle cx="22" cy="22" r="8" fill="${statusColor}" opacity="0.15"/>
              <circle cx="22" cy="22" r="5" fill="${statusColor}">
                <animate attributeName="opacity" values="1;0.5;1" dur="2s" repeatCount="indefinite"/>
              </circle>
            </svg>
          </div>
          <div class="service-info">
            <div class="service-name">${String(svc?.name || '').toUpperCase()}</div>
            <div class="service-url">${urlText}</div>
          </div>
          <button class="service-health-btn" data-action="refresh-services" title="Refresh Services">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
              <path d="M21 3v6h-6"></path>
            </svg>
          </button>
        </div>
        <div class="service-card-footer">
          <span class="service-port">Port: ${portText}</span>
          <span class="service-badge ${badgeClass}">${statusLabel}</span>
        </div>
        ${description || error ? `<div class="service-meta">${description}${description && error ? ' \u2022 ' : ''}${error}</div>` : ''}
      </div>
    `;
  }
}

module.exports = ServiceStatusBinder;
