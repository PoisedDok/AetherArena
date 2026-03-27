/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */

'use strict';

const DaemonConfigModal = require('../../../../src/renderer/main/modules/settings/DaemonConfigModal');
const Toast = require('../../../../src/renderer/shared/components/Toast');

// Mock external dependencies
jest.mock('../../../../src/renderer/shared/components/Toast', () => ({
  show: jest.fn(),
  success: jest.fn(),
  error: jest.fn(),
  info: jest.fn()
}));

describe('DaemonConfigModal', () => {
  let mockEndpoint;
  let mockOnSave;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockEndpoint = {
      getFileIndexingDaemonConfig: jest.fn().mockResolvedValue({
        browser: { scan_interval_seconds: 5, retention_days: 7 },
        email: { scan_interval_seconds: 10, max_emails_per_scan: 20 },
        file_indexing: { scan_check_interval_seconds: 30 }
      }),
      updateFileIndexingDaemonConfig: jest.fn().mockResolvedValue(true),
      restartFileIndexingDaemon: jest.fn().mockResolvedValue(true)
    };
    
    mockOnSave = jest.fn().mockResolvedValue(undefined);
    
    // Clear DOM
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
  });

  function createModal(daemonName, overrides = {}) {
    return new DaemonConfigModal({
      daemonName,
      endpoint: mockEndpoint,
      onSave: mockOnSave,
      ...overrides
    });
  }

  describe('constructor', () => {
    test('initializes with correct properties', () => {
      const modal = createModal('browser');
      expect(modal.daemonName).toBe('browser');
      expect(modal.endpoint).toBe(mockEndpoint);
      expect(modal.onSave).toBe(mockOnSave);
      expect(modal._cleanups).toEqual([]);
    });

    test('uses fallback display name for unknown daemon', () => {
      const modal = createModal('unknown_daemon');
      expect(modal.title).toBe('unknown_daemon Settings');
    });
  });

  describe('open() and render', () => {
    test('renders browser form correctly', async () => {
      const modal = createModal('browser');
      
      // Mock _fetchBrowserTypes so it doesn't block or error
      modal._fetchBrowserTypes = jest.fn().mockResolvedValue(undefined);
      modal._initBrowserHistorySection = jest.fn();

      await modal.open();
      
      expect(mockEndpoint.getFileIndexingDaemonConfig).toHaveBeenCalled();
      
      const form = modal.panel.querySelector('.dcm-form');
      expect(form).not.toBeNull();
      expect(form.getAttribute('data-daemon')).toBe('browser');
      
      const inputs = modal.panel.querySelectorAll('input, select');
      expect(inputs.length).toBeGreaterThan(0);
      
      // Check config is loaded into inputs
      const scanInterval = modal.panel.querySelector('#dcm-scan_interval_seconds');
      expect(scanInterval.value).toBe('5'); // from mockResolvedValue
      
      const retention = modal.panel.querySelector('#dcm-retention_days');
      expect(retention.value).toBe('7');
    });

    test('renders unknown daemon gracefully', async () => {
      const modal = createModal('unknown_daemon');
      await modal.open();
      
      const errorDiv = modal.panel.querySelector('.dcm-error');
      expect(errorDiv).not.toBeNull();
      expect(errorDiv.textContent).toContain('Unknown daemon: unknown_daemon');
    });
  });

  describe('validation', () => {
    test('validates required fields and min/max', async () => {
      const modal = createModal('browser');
      modal._fetchBrowserTypes = jest.fn().mockResolvedValue();
      await modal.open();
      
      // Find scan_interval_seconds and set below min
      const scanInterval = modal.panel.querySelector('#dcm-scan_interval_seconds');
      scanInterval.value = '0'; // min is 1
      
      const formData = modal._collectFormData();
      expect(formData).toBeNull();
      
      // We don't check Toast.error here anymore since _collectFormData only sets DOM error state
    });

    test('passes validation for valid inputs', async () => {
      const modal = createModal('browser');
      modal._fetchBrowserTypes = jest.fn().mockResolvedValue();
      await modal.open();
      
      const scanInterval = modal.panel.querySelector('#dcm-scan_interval_seconds');
      scanInterval.value = '10';
      
      const formData = modal._collectFormData();
      expect(formData).not.toBeNull();
      expect(formData.scan_interval_seconds).toBe(10);
    });
  });

  describe('_handleSave()', () => {
    test('aborts save if validation fails', async () => {
      const modal = createModal('browser');
      modal._fetchBrowserTypes = jest.fn().mockResolvedValue();
      await modal.open();
      
      modal._collectFormData = jest.fn().mockReturnValue(null);
      await modal._handleSave();
      
      expect(mockEndpoint.updateFileIndexingDaemonConfig).not.toHaveBeenCalled();
      expect(mockOnSave).not.toHaveBeenCalled();
    });

    test('collects form data and calls endpoint to save', async () => {
      const modal = createModal('browser');
      modal._fetchBrowserTypes = jest.fn().mockResolvedValue();
      await modal.open();
      
      // Update a value
      modal.panel.querySelector('#dcm-scan_interval_seconds').value = '123';
      modal.panel.querySelector('#dcm-log_level').value = 'DEBUG';
      modal.panel.querySelector('#dcm-auto_detect_profiles').checked = false;
      
      await modal._handleSave();
      
      expect(mockEndpoint.updateFileIndexingDaemonConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          browser: expect.objectContaining({
            scan_interval_seconds: 123,
            log_level: 'DEBUG',
            auto_detect_profiles: false
          })
        })
      );
      expect(mockOnSave).toHaveBeenCalled();
    });
  });

  describe('event listeners', () => {
    test('cancel button closes modal', async () => {
      const modal = createModal('browser');
      modal._fetchBrowserTypes = jest.fn().mockResolvedValue();
      await modal.open();
      
      jest.spyOn(modal, 'close');
      const cancelBtn = modal.panel.querySelector('[data-action="cancel"]');
      cancelBtn.click();
      
      expect(modal.close).toHaveBeenCalled();
    });

    test('restart daemon button calls endpoint', async () => {
      const modal = createModal('file_indexing');
      modal._fetchDaemonStatus = jest.fn().mockResolvedValue();
      await modal.open();
      
      const restartBtn = modal.panel.querySelector('[data-action="restart-daemon"]');
      expect(restartBtn).not.toBeNull();
      
      await restartBtn.click();
      
      expect(mockEndpoint.restartFileIndexingDaemon).toHaveBeenCalled();
      expect(Toast.success).toHaveBeenCalledWith(expect.stringContaining('restarted'));
    });
  });

  describe('_cleanup()', () => {
    test('cleans up event listeners and references', async () => {
      const modal = createModal('browser');
      modal._fetchBrowserTypes = jest.fn().mockResolvedValue();
      await modal.open();
      
      expect(modal._cleanups.length).toBeGreaterThan(0);
      
      modal._cleanup();
      
      expect(modal._cleanups.length).toBe(0);
      expect(modal._isDisposed).toBe(true);
    });
  });
});