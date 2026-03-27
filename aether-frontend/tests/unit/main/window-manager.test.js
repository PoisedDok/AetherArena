'use strict';

// =============================================================================
// Mocks (before require)
// =============================================================================

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../../../src/core/utils/logger', () => ({
  logger: { child: jest.fn(() => mockLog) },
}));

const mockMainBw = createMockBw('main');
mockMainBw.webContents = {
  send: jest.fn(),
  isDestroyed: jest.fn(() => false),
};
const mockMainWinInstance = {
  create: jest.fn(),
  getWindow: jest.fn(() => mockMainBw),
  destroy: jest.fn(),
  toggleWidgetMode: jest.fn(),
  enterWidgetMode: jest.fn(),
  exitWidgetMode: jest.fn(),
  startWidgetDrag: jest.fn(),
  moveWidgetDrag: jest.fn(),
  endWidgetDrag: jest.fn(),
  handleWheelEvent: jest.fn(),
  zoomIn: jest.fn(),
  zoomOut: jest.fn(),
  isWidgetMode: false,
};
jest.mock('../../../src/main/windows/MainWindow', () => jest.fn(() => mockMainWinInstance));

function createMockBw(name) {
  return {
    isDestroyed: jest.fn(() => false),
    isVisible: jest.fn(() => false),
    on: jest.fn(),
    removeListener: jest.fn(),
    _name: name,
  };
}

const mockChatBw = createMockBw('chat');
const mockChatWinInstance = {
  create: jest.fn(),
  getWindow: jest.fn(() => mockChatBw),
  exists: jest.fn(() => true),
  destroy: jest.fn(),
  setQuitting: jest.fn(),
  control: jest.fn(),
  show: jest.fn(),
  focus: jest.fn(),
  hide: jest.fn(),
  fadeHide: jest.fn(),
  cancelFade: jest.fn(),
};
jest.mock('../../../src/main/windows/ChatWindow', () => jest.fn(() => mockChatWinInstance));

const mockArtifactsBw = createMockBw('artifacts');
const mockArtifactsWinInstance = {
  create: jest.fn(),
  getWindow: jest.fn(() => mockArtifactsBw),
  exists: jest.fn(() => true),
  destroy: jest.fn(),
  setQuitting: jest.fn(),
  setActive: jest.fn(),
  getActive: jest.fn(() => false),
  control: jest.fn(),
  send: jest.fn(() => true),
  show: jest.fn(),
  focus: jest.fn(),
  hide: jest.fn(),
  fadeHide: jest.fn(),
  cancelFade: jest.fn(),
};
jest.mock('../../../src/main/windows/ArtifactsWindow', () => jest.fn(() => mockArtifactsWinInstance));

const mockDialog = { showSaveDialog: jest.fn() };
const mockShell = { openPath: jest.fn() };
jest.mock('electron', () => ({ dialog: mockDialog, shell: mockShell }), { virtual: true });

const mockFs = { writeFileSync: jest.fn(), existsSync: jest.fn(() => true) };
jest.mock('fs', () => mockFs);

const { WindowManager, createManager } = require('../../../src/main/windows/WindowManager');

// =============================================================================
// Tests
// =============================================================================

describe('WindowManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMainWinInstance.isWidgetMode = false;
    mockChatWinInstance.exists.mockReturnValue(true);
    mockArtifactsWinInstance.exists.mockReturnValue(true);
    mockArtifactsWinInstance.send.mockReturnValue(true);
    // Reset BW mocks to valid defaults
    mockMainBw.isDestroyed.mockReturnValue(false);
    mockMainBw.webContents.isDestroyed.mockReturnValue(false);
    mockMainWinInstance.getWindow.mockReturnValue(mockMainBw);
    mockChatBw.isDestroyed.mockReturnValue(false);
    mockChatBw.isVisible.mockReturnValue(false);
    mockArtifactsBw.isDestroyed.mockReturnValue(false);
    mockArtifactsBw.isVisible.mockReturnValue(false);
    mockChatWinInstance.getWindow.mockReturnValue(mockChatBw);
    mockArtifactsWinInstance.getWindow.mockReturnValue(mockArtifactsBw);
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('initializes with null windows', () => {
      const wm = new WindowManager();
      expect(wm.mainWindow).toBeNull();
      expect(wm.chatWindow).toBeNull();
      expect(wm.artifactsWindow).toBeNull();
      expect(wm.isQuitting).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // initialize
  // ---------------------------------------------------------------------------

  describe('initialize()', () => {
    it('creates main window', async () => {
      const wm = new WindowManager();
      await wm.initialize();
      expect(wm.mainWindow).not.toBeNull();
      expect(mockMainWinInstance.create).toHaveBeenCalled();
    });

    it('throws on failure', async () => {
      mockMainWinInstance.create.mockImplementationOnce(() => { throw new Error('create fail'); });
      const wm = new WindowManager();
      await expect(wm.initialize()).rejects.toThrow('create fail');
      expect(mockLog.error).toHaveBeenCalledWith('Failed to initialize windows', expect.objectContaining({ error: 'create fail' }));
    });
  });

  // ---------------------------------------------------------------------------
  // createAuxWindows
  // ---------------------------------------------------------------------------

  describe('createAuxWindows()', () => {
    it('creates chat and artifacts windows (both hidden initially)', () => {
      const wm = new WindowManager();
      mockChatWinInstance.exists.mockReturnValue(false);
      mockArtifactsWinInstance.exists.mockReturnValue(false);
      wm.createAuxWindows();
      expect(wm.chatWindow).not.toBeNull();
      expect(wm.artifactsWindow).not.toBeNull();
      expect(mockChatWinInstance.create).toHaveBeenCalled();
      expect(mockArtifactsWinInstance.create).toHaveBeenCalled();
      // Both are created with show:false — no explicit hide() needed
      expect(mockArtifactsWinInstance.hide).not.toHaveBeenCalled();
    });

    it('does not recreate if already exists', () => {
      const wm = new WindowManager();
      mockChatWinInstance.exists.mockReturnValue(false);
      mockArtifactsWinInstance.exists.mockReturnValue(false);
      wm.createAuxWindows();
      jest.clearAllMocks();
      mockChatWinInstance.exists.mockReturnValue(true);
      mockArtifactsWinInstance.exists.mockReturnValue(true);
      wm.createAuxWindows();
      expect(mockChatWinInstance.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // setQuitting / shutdown
  // ---------------------------------------------------------------------------

  describe('setQuitting()', () => {
    it('propagates to all windows', () => {
      const wm = new WindowManager();
      wm.createAuxWindows();
      wm.setQuitting(true);
      expect(wm.isQuitting).toBe(true);
      expect(mockChatWinInstance.setQuitting).toHaveBeenCalledWith(true);
      expect(mockArtifactsWinInstance.setQuitting).toHaveBeenCalledWith(true);
    });
  });

  describe('shutdown()', () => {
    it('destroys all windows in order', async () => {
      const wm = new WindowManager();
      await wm.initialize();
      wm.createAuxWindows();
      wm.shutdown();
      expect(mockArtifactsWinInstance.destroy).toHaveBeenCalled();
      expect(mockChatWinInstance.destroy).toHaveBeenCalled();
      expect(mockMainWinInstance.destroy).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  describe('getters', () => {
    it('getMainWindow returns null before init', () => {
      expect(new WindowManager().getMainWindow()).toBeUndefined();
    });

    it('getMainWindow returns window after init', async () => {
      const wm = new WindowManager();
      await wm.initialize();
      expect(wm.getMainWindow()).toBe(mockMainBw);
    });

    it('isWidgetMode returns false by default', () => {
      expect(new WindowManager().isWidgetMode).toBe(false);
    });

    it('isWidgetMode delegates to mainWindow', async () => {
      const wm = new WindowManager();
      await wm.initialize();
      mockMainWinInstance.isWidgetMode = true;
      expect(wm.isWidgetMode).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Main window operations
  // ---------------------------------------------------------------------------

  describe('main window operations', () => {
    let wm;
    beforeEach(async () => {
      wm = new WindowManager();
      await wm.initialize();
    });

    it('toggleWidgetMode delegates', () => {
      wm.toggleWidgetMode();
      expect(mockMainWinInstance.toggleWidgetMode).toHaveBeenCalled();
    });

    it('enterWidgetMode delegates', () => {
      wm.enterWidgetMode();
      expect(mockMainWinInstance.enterWidgetMode).toHaveBeenCalled();
    });

    it('exitWidgetMode delegates', () => {
      wm.exitWidgetMode();
      expect(mockMainWinInstance.exitWidgetMode).toHaveBeenCalled();
    });

    it('startWidgetDrag delegates', () => {
      wm.startWidgetDrag({ screenX: 100, screenY: 200 });
      expect(mockMainWinInstance.startWidgetDrag).toHaveBeenCalledWith({ screenX: 100, screenY: 200 });
    });

    it('moveWidgetDrag delegates', () => {
      wm.moveWidgetDrag({ screenX: 120, screenY: 220 });
      expect(mockMainWinInstance.moveWidgetDrag).toHaveBeenCalledWith({ screenX: 120, screenY: 220 });
    });

    it('endWidgetDrag delegates', () => {
      wm.endWidgetDrag();
      expect(mockMainWinInstance.endWidgetDrag).toHaveBeenCalled();
    });

    it('handleWheelEvent delegates', () => {
      wm.handleWheelEvent({ ctrlKey: true });
      expect(mockMainWinInstance.handleWheelEvent).toHaveBeenCalledWith({ ctrlKey: true });
    });

    it('zoomIn delegates', () => {
      wm.zoomIn();
      expect(mockMainWinInstance.zoomIn).toHaveBeenCalled();
    });

    it('zoomOut delegates', () => {
      wm.zoomOut();
      expect(mockMainWinInstance.zoomOut).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Chat window operations
  // ---------------------------------------------------------------------------

  describe('chat window operations', () => {
    it('createChatWindow creates new window', () => {
      const wm = new WindowManager();
      wm.createChatWindow();
      expect(wm.chatWindow).not.toBeNull();
      expect(mockChatWinInstance.create).toHaveBeenCalled();
    });

    it('controlChatWindow creates window if not exists', () => {
      const wm = new WindowManager();
      wm.controlChatWindow('minimize');
      expect(mockChatWinInstance.create).toHaveBeenCalled();
    });

    it('controlChatWindow delegates when exists', () => {
      const wm = new WindowManager();
      wm.createAuxWindows();
      wm.controlChatWindow('minimize');
      expect(mockChatWinInstance.control).toHaveBeenCalledWith('minimize');
    });
  });

  // ---------------------------------------------------------------------------
  // Artifacts window operations
  // ---------------------------------------------------------------------------

  describe('artifacts window operations', () => {
    it('createArtifactsWindow creates new window', () => {
      const wm = new WindowManager();
      wm.createArtifactsWindow();
      expect(mockArtifactsWinInstance.create).toHaveBeenCalled();
    });

    it('controlArtifactsWindow creates window if not exists', () => {
      const wm = new WindowManager();
      wm.controlArtifactsWindow('close');
      expect(mockArtifactsWinInstance.create).toHaveBeenCalled();
    });

    it('controlArtifactsWindow delegates when exists', () => {
      const wm = new WindowManager();
      wm.createAuxWindows();
      wm.controlArtifactsWindow('close');
      expect(mockArtifactsWinInstance.control).toHaveBeenCalledWith('close');
    });

    it('setArtifactsWindowState sets active', () => {
      const wm = new WindowManager();
      wm.createAuxWindows();
      wm.setArtifactsWindowState({ active: true });
      expect(mockArtifactsWinInstance.setActive).toHaveBeenCalledWith(true);
    });

    it('isArtifactsWindowActive returns false by default', () => {
      expect(new WindowManager().isArtifactsWindowActive()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // sendToArtifacts
  // ---------------------------------------------------------------------------

  describe('sendToArtifacts()', () => {
    it('creates window if not exists and sends', () => {
      const wm = new WindowManager();
      const result = wm.sendToArtifacts('test:channel', 'data');
      expect(mockArtifactsWinInstance.create).toHaveBeenCalled();
      expect(mockArtifactsWinInstance.send).toHaveBeenCalledWith('test:channel', 'data');
      expect(result).toBe(true);
    });

    it('sends to existing window', () => {
      const wm = new WindowManager();
      wm.createAuxWindows();
      wm.sendToArtifacts('test:channel', 'data');
      expect(mockArtifactsWinInstance.send).toHaveBeenCalledWith('test:channel', 'data');
    });

    it('does not show already visible window', () => {
      const wm = new WindowManager();
      wm.createAuxWindows();
      mockArtifactsBw.isVisible.mockReturnValue(true);
      mockArtifactsWinInstance.show.mockClear();
      wm.sendToArtifacts('test:channel');
      expect(mockArtifactsWinInstance.show).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // scheduleArtifactsAutoHide / cancelArtifactsAutoHide
  // ---------------------------------------------------------------------------

  describe('scheduleArtifactsAutoHide()', () => {
    it('fade-hides artifacts after 2s delay', () => {
      jest.useFakeTimers();
      const wm = new WindowManager();
      wm.createAuxWindows();
      mockArtifactsBw.isVisible.mockReturnValue(true);
      wm.scheduleArtifactsAutoHide();
      expect(mockArtifactsWinInstance.fadeHide).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2000);
      expect(mockArtifactsWinInstance.fadeHide).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('resets timer on rapid calls (only last fires)', () => {
      jest.useFakeTimers();
      const wm = new WindowManager();
      wm.createAuxWindows();
      mockArtifactsBw.isVisible.mockReturnValue(true);
      wm.scheduleArtifactsAutoHide();
      jest.advanceTimersByTime(1500);
      wm.scheduleArtifactsAutoHide(); // reset
      jest.advanceTimersByTime(1500);
      expect(mockArtifactsWinInstance.fadeHide).not.toHaveBeenCalled();
      jest.advanceTimersByTime(500);
      expect(mockArtifactsWinInstance.fadeHide).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('skips fadeHide if artifacts is already hidden', () => {
      jest.useFakeTimers();
      const wm = new WindowManager();
      wm.createAuxWindows();
      mockArtifactsBw.isVisible.mockReturnValue(false);
      wm.scheduleArtifactsAutoHide();
      jest.advanceTimersByTime(2000);
      expect(mockArtifactsWinInstance.fadeHide).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('cancelArtifactsAutoHide()', () => {
    it('cancels pending auto-hide timer', () => {
      jest.useFakeTimers();
      const wm = new WindowManager();
      wm.createAuxWindows();
      mockArtifactsBw.isVisible.mockReturnValue(true);
      wm.scheduleArtifactsAutoHide();
      wm.cancelArtifactsAutoHide();
      jest.advanceTimersByTime(3000);
      expect(mockArtifactsWinInstance.fadeHide).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('no-op when no timer is pending', () => {
      const wm = new WindowManager();
      expect(() => wm.cancelArtifactsAutoHide()).not.toThrow();
    });
  });

  describe('sendToArtifacts() cancels auto-hide', () => {
    it('cancels pending auto-hide and fade when new data arrives', () => {
      jest.useFakeTimers();
      const wm = new WindowManager();
      wm.createAuxWindows();
      mockArtifactsBw.isVisible.mockReturnValue(true);
      wm.scheduleArtifactsAutoHide();
      jest.advanceTimersByTime(1000);
      // New data arrives mid-timer
      wm.sendToArtifacts('artifacts:stream', { data: 'new' });
      expect(mockArtifactsWinInstance.cancelFade).toHaveBeenCalled();
      jest.advanceTimersByTime(2000);
      expect(mockArtifactsWinInstance.fadeHide).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('shutdown() cleanup', () => {
    it('cancels auto-hide timer and fades during shutdown', async () => {
      jest.useFakeTimers();
      const wm = new WindowManager();
      await wm.initialize();
      wm.createAuxWindows();
      wm.scheduleArtifactsAutoHide();
      wm.shutdown();
      expect(mockChatWinInstance.cancelFade).toHaveBeenCalled();
      expect(mockArtifactsWinInstance.cancelFade).toHaveBeenCalled();
      // Auto-hide should not fire after shutdown
      jest.advanceTimersByTime(3000);
      expect(mockArtifactsWinInstance.fadeHide).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // focusArtifacts
  // ---------------------------------------------------------------------------

  describe('focusArtifacts()', () => {
    it('creates window if not exists', () => {
      jest.useFakeTimers();
      const wm = new WindowManager();
      mockArtifactsWinInstance.exists.mockReturnValue(false);
      wm.focusArtifacts({ id: '1' });
      expect(mockArtifactsWinInstance.create).toHaveBeenCalled();
      jest.advanceTimersByTime(500);
      jest.useRealTimers();
    });

    it('sends focus-artifacts to existing window', () => {
      const wm = new WindowManager();
      wm.createAuxWindows();
      wm.focusArtifacts({ id: '1' });
      expect(mockArtifactsWinInstance.send).toHaveBeenCalledWith('artifacts:focus-artifacts', { id: '1' });
    });
  });

  // ---------------------------------------------------------------------------
  // loadArtifactsCode / loadArtifactsOutput
  // ---------------------------------------------------------------------------

  describe('loadArtifactsCode()', () => {
    it('sends to existing window and focuses', () => {
      const wm = new WindowManager();
      wm.createAuxWindows();
      wm.loadArtifactsCode({ code: 'x' });
      expect(mockArtifactsWinInstance.send).toHaveBeenCalledWith('artifacts:load-code', { code: 'x' });
      expect(mockArtifactsWinInstance.focus).toHaveBeenCalled();
    });

    it('creates window and queues if not exists', () => {
      jest.useFakeTimers();
      const wm = new WindowManager();
      mockArtifactsWinInstance.exists.mockReturnValue(false);
      wm.loadArtifactsCode({ code: 'x' });
      expect(mockArtifactsWinInstance.create).toHaveBeenCalled();
      mockArtifactsWinInstance.exists.mockReturnValue(true);
      jest.advanceTimersByTime(500);
      expect(mockArtifactsWinInstance.send).toHaveBeenCalledWith('artifacts:load-code', { code: 'x' });
      jest.useRealTimers();
    });
  });

  describe('loadArtifactsOutput()', () => {
    it('sends to existing window', () => {
      const wm = new WindowManager();
      wm.createAuxWindows();
      wm.loadArtifactsOutput({ output: 'y' });
      expect(mockArtifactsWinInstance.send).toHaveBeenCalledWith('artifacts:load-output', { output: 'y' });
    });

    it('creates window and queues if not exists', () => {
      jest.useFakeTimers();
      const wm = new WindowManager();
      mockArtifactsWinInstance.exists.mockReturnValue(false);
      wm.loadArtifactsOutput({ output: 'y' });
      mockArtifactsWinInstance.exists.mockReturnValue(true);
      jest.advanceTimersByTime(500);
      expect(mockArtifactsWinInstance.send).toHaveBeenCalledWith('artifacts:load-output', { output: 'y' });
      jest.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // File operations
  // ---------------------------------------------------------------------------

  describe('exportArtifactFile()', () => {
    it('exports file on dialog confirm', async () => {
      mockDialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/out.txt' });
      const wm = new WindowManager();
      await wm.exportArtifactFile({ name: 'test.txt', content: 'hello' });
      expect(mockFs.writeFileSync).toHaveBeenCalledWith('/tmp/out.txt', 'hello', 'utf8');
    });

    it('does nothing on dialog cancel', async () => {
      mockDialog.showSaveDialog.mockResolvedValueOnce({ canceled: true });
      const wm = new WindowManager();
      await wm.exportArtifactFile({ name: 'test.txt' });
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('handles export error', async () => {
      mockDialog.showSaveDialog.mockRejectedValueOnce(new Error('dialog fail'));
      const wm = new WindowManager();
      await wm.exportArtifactFile({});
      expect(mockLog.error).toHaveBeenCalledWith('File export failed', { error: 'dialog fail' });
    });
  });

  describe('openFile()', () => {
    it('opens file with shell', async () => {
      mockShell.openPath.mockResolvedValueOnce('');
      const wm = new WindowManager();
      await wm.openFile({ path: '/tmp/file.txt' });
      expect(mockShell.openPath).toHaveBeenCalledWith('/tmp/file.txt');
    });

    it('logs error when no path provided', async () => {
      const wm = new WindowManager();
      await wm.openFile({});
      expect(mockLog.error).toHaveBeenCalledWith('No file path provided');
    });

    it('logs error when file does not exist', async () => {
      mockFs.existsSync.mockReturnValueOnce(false);
      const wm = new WindowManager();
      await wm.openFile({ path: '/missing' });
      expect(mockLog.error).toHaveBeenCalledWith('File does not exist', { filePath: '/missing' });
    });

    it('logs error on shell.openPath failure', async () => {
      mockShell.openPath.mockResolvedValueOnce('failed to open');
      const wm = new WindowManager();
      await wm.openFile({ path: '/tmp/file' });
      expect(mockLog.error).toHaveBeenCalledWith('Failed to open file', expect.objectContaining({ error: 'failed to open' }));
    });

    it('handles openPath exception', async () => {
      mockShell.openPath.mockRejectedValueOnce(new Error('shell fail'));
      const wm = new WindowManager();
      await wm.openFile({ path: '/tmp/file' });
      expect(mockLog.error).toHaveBeenCalledWith('File open failed', { error: 'shell fail' });
    });
  });

  // ---------------------------------------------------------------------------
  // createManager
  // ---------------------------------------------------------------------------

  describe('createManager()', () => {
    it('creates new instance', () => {
      expect(createManager()).toBeInstanceOf(WindowManager);
    });
  });
});
