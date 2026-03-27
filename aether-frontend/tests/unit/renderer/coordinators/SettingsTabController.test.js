'use strict';

// Mock UserCredentialsSettings (lazy-required inside switchTab)
jest.mock('../../../../src/renderer/main/modules/settings/UserCredentialsSettings', () => ({
  initialize: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

// Mock Toast (used for save success/error feedback)
jest.mock('../../../../src/renderer/shared/components/Toast', () => ({
  success: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
}));

jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => ({
  confirm: jest.fn(),
}));

jest.mock('../../../../src/renderer/main/modules/shutdown/ShutdownOrchestrator', () => {
  return jest.fn().mockImplementation(() => ({
    execute: jest.fn(),
  }));
});

const SettingsTabController = require('../../../../src/renderer/main/runtime/coordinators/SettingsTabController');
const ConfirmDialog = require('../../../../src/renderer/shared/components/ConfirmDialog');
const ShutdownOrchestrator = require('../../../../src/renderer/main/modules/shutdown/ShutdownOrchestrator');

// Helper: create a minimal mock element
function mockElement(classes = []) {
  const classList = new Set(classes);
  return {
    classList: {
      add: jest.fn((c) => classList.add(c)),
      remove: jest.fn((c) => classList.delete(c)),
      contains: jest.fn((c) => classList.has(c)),
    },
  };
}

// Helper: create standard options with mocks
function createOptions(overrides = {}) {
  return {
    settingsModal: mockElement(['hidden']),
    settingsManager: {
      loadSettings: jest.fn().mockResolvedValue(undefined),
      saveSettings: jest.fn().mockResolvedValue(undefined),
      loadServicesStatus: jest.fn().mockResolvedValue(undefined),
      currentSettings: { ui: { effects: true }, interpreter: { profile: 'standard' } },
    },
    llmProviderSettings: { initialize: jest.fn().mockResolvedValue(undefined) },
    fileIndexingManager: { initialize: jest.fn().mockResolvedValue(undefined) },
    proactiveDaemonManager: { initialize: jest.fn().mockResolvedValue(undefined) },
    browserHistoryManager: { initialize: jest.fn().mockResolvedValue(undefined) },
    applyUiSettings: jest.fn(),
    ...overrides,
  };
}

describe('SettingsTabController', () => {
  let ctrl;
  let options;

  beforeEach(() => {
    jest.useFakeTimers();

    // Setup minimal DOM for switchTab
    document.body.innerHTML = `
      <div class="settings-tab" data-tab="assistant"></div>
      <div class="settings-tab" data-tab="connections"></div>
      <div class="settings-tab" data-tab="documents"></div>
      <div class="settings-tab" data-tab="apikeys"></div>
      <div class="settings-tab" data-tab="about"></div>
      <div class="settings-section" id="tab-assistant"></div>
      <div class="settings-section" id="tab-connections"></div>
      <div class="settings-section" id="tab-documents"></div>
      <div class="settings-section" id="tab-apikeys"></div>
      <div class="settings-section" id="tab-about">
        <button id="about-open-notices"></button>
      </div>
      <div id="user-credentials-container"></div>
    `;

    // Polyfill requestAnimationFrame for JSDOM
    global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

    ConfirmDialog.confirm.mockClear();
    ShutdownOrchestrator.mockClear();
    const Toast = require('../../../../src/renderer/shared/components/Toast');
    Toast.success.mockClear();
    Toast.error.mockClear();

    options = createOptions();
    ctrl = new SettingsTabController(options);
  });

  afterEach(() => {
    ctrl.dispose();
    jest.useRealTimers();
    document.body.innerHTML = '';
    delete global.requestAnimationFrame;
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    it('initializes with provided options', () => {
      expect(ctrl._settingsModal).toBe(options.settingsModal);
      expect(ctrl._settingsManager).toBe(options.settingsManager);
      expect(ctrl._isDisposed).toBe(false);
    });

    it('handles missing options gracefully', () => {
      const bare = new SettingsTabController();
      expect(bare._settingsModal).toBeNull();
      expect(bare._settingsManager).toBeNull();
      expect(bare._isDisposed).toBe(false);
      bare.dispose();
    });

    it('initializes all lazy flags to false', () => {
      expect(ctrl._llmProviderInitialized).toBe(false);
      expect(ctrl._proactiveDaemonsInitialized).toBe(false);
      expect(ctrl._fileIndexingInitialized).toBe(false);
      expect(ctrl._browserHistoryInitialized).toBe(false);
      expect(ctrl._userCredentialsInitialized).toBe(false);
      expect(ctrl._aboutInitialized).toBe(false);
    });
  });

  // =========================================================================
  // open()
  // =========================================================================
  describe('open()', () => {
    it('removes hidden class from modal', async () => {
      await ctrl.open();
      expect(options.settingsModal.classList.remove).toHaveBeenCalledWith('hidden');
    });

    it('adds is-visible class via requestAnimationFrame', async () => {
      await ctrl.open();
      jest.runAllTimers();
      expect(options.settingsModal.classList.add).toHaveBeenCalledWith('is-visible');
    });

    it('calls loadSettings on settingsManager', async () => {
      await ctrl.open();
      expect(options.settingsManager.loadSettings).toHaveBeenCalledTimes(1);
    });

    it('applies UI settings after load', async () => {
      await ctrl.open();
      expect(options.applyUiSettings).toHaveBeenCalledWith({ effects: true });
    });

    it('initializes LLM provider on first open', async () => {
      await ctrl.open();
      expect(options.llmProviderSettings.initialize).toHaveBeenCalledTimes(1);
      expect(ctrl._llmProviderInitialized).toBe(true);
    });

    it('does not re-initialize LLM provider on second open', async () => {
      await ctrl.open();
      await ctrl.open();
      expect(options.llmProviderSettings.initialize).toHaveBeenCalledTimes(1);
    });

    it('is no-op when disposed', async () => {
      ctrl.dispose();
      await ctrl.open();
      expect(options.settingsManager.loadSettings).not.toHaveBeenCalled();
    });

    it('is no-op when settingsModal is null', async () => {
      const noModalCtrl = new SettingsTabController(createOptions({ settingsModal: null }));
      await noModalCtrl.open();
      expect(options.settingsManager.loadSettings).not.toHaveBeenCalled();
      noModalCtrl.dispose();
    });

    it('handles loadSettings failure gracefully', async () => {
      options.settingsManager.loadSettings.mockRejectedValue(new Error('load fail'));
      await expect(ctrl.open()).resolves.not.toThrow();
    });

    it('handles LLM provider init failure gracefully', async () => {
      options.llmProviderSettings.initialize.mockRejectedValue(new Error('llm fail'));
      await expect(ctrl.open()).resolves.not.toThrow();
    });

    it('skips applyUiSettings if currentSettings.ui is null', async () => {
      options.settingsManager.currentSettings = {};
      await ctrl.open();
      expect(options.applyUiSettings).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // close()
  // =========================================================================
  describe('close()', () => {
    it('removes is-visible class', () => {
      ctrl.close();
      expect(options.settingsModal.classList.remove).toHaveBeenCalledWith('is-visible');
    });

    it('adds hidden class after animation timeout', () => {
      ctrl.close();
      jest.advanceTimersByTime(250);
      expect(options.settingsModal.classList.add).toHaveBeenCalledWith('hidden');
    });

    it('clears prior hide timer on rapid close calls', () => {
      ctrl.close();
      ctrl.close();
      // Only one timer should be pending
      jest.advanceTimersByTime(250);
      // No double-fire
    });

    it('is no-op when disposed', () => {
      ctrl.dispose();
      ctrl.close();
      // Should not throw
    });

    it('is no-op when settingsModal is null', () => {
      const noModal = new SettingsTabController(createOptions({ settingsModal: null }));
      expect(() => noModal.close()).not.toThrow();
      noModal.dispose();
    });
  });

  // =========================================================================
  // switchTab()
  // =========================================================================
  describe('switchTab()', () => {
    it('activates the correct tab and section', () => {
      ctrl.switchTab('connections');
      const tab = document.querySelector('.settings-tab[data-tab="connections"]');
      const section = document.getElementById('tab-connections');
      expect(tab.classList.contains('active')).toBe(true);
      expect(section.classList.contains('active')).toBe(true);
    });

    it('deactivates other tabs when switching', () => {
      ctrl.switchTab('assistant');
      ctrl.switchTab('connections');
      const assistantTab = document.querySelector('.settings-tab[data-tab="assistant"]');
      expect(assistantTab.classList.contains('active')).toBe(false);
    });

    it('loads services status on connections tab', () => {
      ctrl.switchTab('connections');
      expect(options.settingsManager.loadServicesStatus).toHaveBeenCalledTimes(1);
    });

    it('initializes file indexing on first documents tab visit', () => {
      ctrl.switchTab('documents');
      expect(options.fileIndexingManager.initialize).toHaveBeenCalledTimes(1);
      expect(ctrl._fileIndexingInitialized).toBe(true);
    });

    it('initializes proactive daemon on first documents tab visit', () => {
      ctrl.switchTab('documents');
      expect(options.proactiveDaemonManager.initialize).toHaveBeenCalledTimes(1);
      expect(ctrl._proactiveDaemonsInitialized).toBe(true);
    });

    it('does not eagerly initialize browser history (now handled by DaemonConfigModal)', () => {
      ctrl.switchTab('documents');
      // BrowserHistoryManager is no longer eagerly initialized on tab switch.
      // It's instantiated inside DaemonConfigModal when the browser daemon settings are opened.
      expect(options.browserHistoryManager.initialize).not.toHaveBeenCalled();
    });

    it('does not re-initialize documents managers on second visit', () => {
      ctrl.switchTab('documents');
      ctrl.switchTab('documents');
      expect(options.fileIndexingManager.initialize).toHaveBeenCalledTimes(1);
      expect(options.proactiveDaemonManager.initialize).toHaveBeenCalledTimes(1);
      // browserHistoryManager.initialize NOT called — handled by DaemonConfigModal
    });

    it('initializes user credentials on first apikeys tab visit', () => {
      ctrl.switchTab('apikeys');
      expect(ctrl._userCredentialsInitialized).toBe(true);
    });

    it('does not re-initialize user credentials on second visit', () => {
      const UserCredentialsSettings = require('../../../../src/renderer/main/modules/settings/UserCredentialsSettings');
      UserCredentialsSettings.initialize.mockClear();
      ctrl.switchTab('apikeys');
      ctrl.switchTab('apikeys');
      expect(UserCredentialsSettings.initialize).toHaveBeenCalledTimes(1);
    });

    it('activates about tab and section', () => {
      ctrl.switchTab('about');
      const tab = document.querySelector('.settings-tab[data-tab="about"]');
      const section = document.getElementById('tab-about');
      expect(tab.classList.contains('active')).toBe(true);
      expect(section.classList.contains('active')).toBe(true);
    });

    it('initializes about tab on first visit (wires notices button)', () => {
      ctrl.switchTab('about');
      expect(ctrl._aboutInitialized).toBe(true);
      expect(ctrl._aboutNoticesBtnHandler).toEqual(expect.any(Function));
    });

    it('does not re-initialize about tab on second visit', () => {
      ctrl.switchTab('about');
      const firstHandler = ctrl._aboutNoticesBtnHandler;
      ctrl.switchTab('about');
      expect(ctrl._aboutNoticesBtnHandler).toBe(firstHandler);
    });

    it('about notices button calls aether.about.openNoticesFile when available', () => {
      const mockOpenNoticesFile = jest.fn();
      window.aether = { about: { openNoticesFile: mockOpenNoticesFile } };
      ctrl.switchTab('about');
      const btn = document.getElementById('about-open-notices');
      btn.click();
      expect(mockOpenNoticesFile).toHaveBeenCalledTimes(1);
      delete window.aether;
    });

    it('about notices button handles missing aether.about gracefully', () => {
      delete window.aether;
      ctrl.switchTab('about');
      const btn = document.getElementById('about-open-notices');
      expect(() => btn.click()).not.toThrow();
    });

    it('handles missing file indexing manager gracefully', () => {
      const noIdx = new SettingsTabController(createOptions({ fileIndexingManager: null }));
      expect(() => noIdx.switchTab('documents')).not.toThrow();
      noIdx.dispose();
    });

    it('handles missing proactive daemon manager gracefully', () => {
      const noPD = new SettingsTabController(createOptions({ proactiveDaemonManager: null }));
      noPD.switchTab('documents');
      // Should not attempt to initialize
      expect(noPD._proactiveDaemonsInitialized).toBe(false);
      noPD.dispose();
    });

    it('is no-op when disposed', () => {
      ctrl.dispose();
      expect(() => ctrl.switchTab('assistant')).not.toThrow();
    });

    it('handles non-existent tab name without crashing', () => {
      expect(() => ctrl.switchTab('nonexistent')).not.toThrow();
    });
  });

  // =========================================================================
  // save()
  // =========================================================================
  describe('save()', () => {
    it('calls saveSettings on settingsManager', async () => {
      await ctrl.save();
      expect(options.settingsManager.saveSettings).toHaveBeenCalledTimes(1);
    });

    it('saves settings and closes normally when profile does not change', async () => {
      await ctrl.save();
      expect(ConfirmDialog.confirm).not.toHaveBeenCalled();
      const Toast = require('../../../../src/renderer/shared/components/Toast');
      expect(Toast.success).toHaveBeenCalledWith('Settings saved');
    });

    it('prompts for restart and executes orchestrator when profile changes and user confirms', async () => {
      ConfirmDialog.confirm.mockResolvedValueOnce(true);
      // Simulate profile change during saveSettings
      options.settingsManager.saveSettings.mockImplementationOnce(() => {
        options.settingsManager.currentSettings.interpreter.profile = 'advanced';
        return Promise.resolve();
      });

      await ctrl.save();
      
      expect(ConfirmDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Restart Required',
        variant: 'warning'
      }));
      expect(ShutdownOrchestrator).toHaveBeenCalled();
      const orchestratorInstance = ShutdownOrchestrator.mock.results[0].value;
      expect(orchestratorInstance.execute).toHaveBeenCalledWith('restart');
      
      // Modal should not be closed directly via Toast/timeout
      const Toast = require('../../../../src/renderer/shared/components/Toast');
      expect(Toast.success).not.toHaveBeenCalled();
    });

    it('saves settings and closes normally when profile changes but user cancels restart', async () => {
      ConfirmDialog.confirm.mockResolvedValueOnce(false);
      options.settingsManager.saveSettings.mockImplementationOnce(() => {
        options.settingsManager.currentSettings.interpreter.profile = 'advanced';
        return Promise.resolve();
      });

      await ctrl.save();
      
      expect(ConfirmDialog.confirm).toHaveBeenCalled();
      expect(ShutdownOrchestrator).not.toHaveBeenCalled();
      
      const Toast = require('../../../../src/renderer/shared/components/Toast');
      expect(Toast.success).toHaveBeenCalledWith('Settings saved');
      jest.advanceTimersByTime(600);
      expect(options.settingsModal.classList.remove).toHaveBeenCalledWith('is-visible');
    });

    it('applies UI settings after save', async () => {
      await ctrl.save();
      expect(options.applyUiSettings).toHaveBeenCalledWith({ effects: true });
    });

    it('closes modal after 600ms delay on success', async () => {
      await ctrl.save();
      expect(options.settingsModal.classList.remove).not.toHaveBeenCalledWith('is-visible');
      jest.advanceTimersByTime(600);
      expect(options.settingsModal.classList.remove).toHaveBeenCalledWith('is-visible');
    });

    it('shows success toast on save', async () => {
      const Toast = require('../../../../src/renderer/shared/components/Toast');
      await ctrl.save();
      expect(Toast.success).toHaveBeenCalledWith('Settings saved');
    });

    it('is no-op when disposed', async () => {
      ctrl.dispose();
      await ctrl.save();
      expect(options.settingsManager.saveSettings).not.toHaveBeenCalled();
    });

    it('is no-op when settingsManager is null', async () => {
      const noMgr = new SettingsTabController(createOptions({ settingsManager: null }));
      await expect(noMgr.save()).resolves.not.toThrow();
      noMgr.dispose();
    });

    it('handles saveSettings failure gracefully and keeps modal open', async () => {
      const Toast = require('../../../../src/renderer/shared/components/Toast');
      options.settingsManager.saveSettings.mockRejectedValue(new Error('save fail'));
      await expect(ctrl.save()).resolves.not.toThrow();
      expect(Toast.error).toHaveBeenCalledWith('Failed to save settings. Check your connection.');
      // Modal should stay open (no close scheduled)
      jest.advanceTimersByTime(2000);
      expect(options.settingsModal.classList.remove).not.toHaveBeenCalledWith('is-visible');
    });

    it('skips applyUiSettings if currentSettings.ui is null', async () => {
      options.settingsManager.currentSettings = {};
      options.applyUiSettings.mockClear();
      await ctrl.save();
      expect(options.applyUiSettings).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose()', () => {
    it('sets _isDisposed to true', () => {
      ctrl.dispose();
      expect(ctrl._isDisposed).toBe(true);
    });

    it('nulls out all references', () => {
      ctrl.dispose();
      expect(ctrl._settingsModal).toBeNull();
      expect(ctrl._settingsManager).toBeNull();
      expect(ctrl._llmProviderSettings).toBeNull();
      expect(ctrl._fileIndexingManager).toBeNull();
      expect(ctrl._proactiveDaemonManager).toBeNull();
      expect(ctrl._browserHistoryManager).toBeNull();
      expect(ctrl._applyUiSettings).toBeNull();
    });

    it('clears pending hide timer', () => {
      ctrl.close(); // starts a timer
      ctrl.dispose();
      expect(ctrl._settingsHideTimer).toBeNull();
    });

    it('cleans up about tab listener on dispose', () => {
      ctrl.switchTab('about');
      expect(ctrl._aboutNoticesBtnHandler).toEqual(expect.any(Function));
      const btn = document.getElementById('about-open-notices');
      const removeSpy = jest.spyOn(btn, 'removeEventListener');
      ctrl.dispose();
      expect(removeSpy).toHaveBeenCalledWith('click', expect.any(Function));
      expect(ctrl._aboutNoticesBtnHandler).toBeNull();
    });

    it('is idempotent (double dispose)', () => {
      ctrl.dispose();
      expect(() => ctrl.dispose()).not.toThrow();
    });
  });
});
