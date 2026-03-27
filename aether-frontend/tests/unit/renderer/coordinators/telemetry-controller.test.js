'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
}));

const TelemetryController = require('../../../../src/renderer/main/runtime/coordinators/TelemetryController');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createElement() {
  const el = document.createElement('span');
  // classList is real from jsdom, no mock needed
  return el;
}

function createElements() {
  return {
    cpuUsage: createElement(),
    memoryUsage: createElement(),
    fpsCounter: createElement(),
    micPercentage: createElement(),
    systemStatus: createElement(),
    networkLatency: createElement(),
    nodeCount: createElement(),
    systemTime: createElement(),
    modelStatusDot: createElement(),
    modelName: createElement(),
  };
}

function createMockAether(stats = null) {
  return {
    system: {
      getStats: jest.fn().mockResolvedValue(stats || {
        cpu: { percent: 42 },
        process: { memory: 512 * 1024 * 1024 }, // 512 MB
      }),
    },
  };
}

function createMockGuru(overrides = {}) {
  return {
    state: {
      audioLevel: 0.75,
      assistant: 'listening',
      ...overrides,
    },
    lastPingTime: 23,
  };
}

function createMockVisualizer(overrides = {}) {
  return {
    fpsValues: [58, 60, 62],
    neuralNetwork: {
      nodes: new Array(42),
    },
    ...overrides,
  };
}

function createMockEndpoint(health = null) {
  return {
    getHealth: jest.fn().mockResolvedValue(health || {
      model: 'lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit',
      status: 'ok',
    }),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TelemetryController', () => {
  let controller;

  beforeEach(() => {
    jest.useFakeTimers();

    const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    });

    // Reset document.hidden
    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: false,
    });

    // Clear window.endpoint
    delete window.endpoint;

    controller = null;
  });

  afterEach(() => {
    if (controller) {
      try { controller.dispose(); } catch (_) { /* already disposed */ }
    }
    jest.useRealTimers();
    delete window.endpoint;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('creates instance with defaults', () => {
      controller = new TelemetryController();
      expect(controller).toBeInstanceOf(TelemetryController);
      expect(controller.aether).toBeNull();
      expect(controller.guru).toBeNull();
      expect(controller.visualizer).toBeNull();
      expect(controller.endpoint).toBeNull();
      expect(controller.elements).toEqual({});
    });

    it('accepts all options', () => {
      const aether = createMockAether();
      const guru = createMockGuru();
      const visualizer = createMockVisualizer();
      const endpoint = createMockEndpoint();
      const elements = createElements();

      controller = new TelemetryController({ aether, guru, visualizer, endpoint, elements });
      expect(controller.aether).toBe(aether);
      expect(controller.guru).toBe(guru);
      expect(controller.visualizer).toBe(visualizer);
      expect(controller.endpoint).toBe(endpoint);
      expect(controller.elements).toBe(elements);
    });

    it('initializes all interval IDs to null', () => {
      controller = new TelemetryController();
      expect(controller._telemetryInterval).toBeNull();
      expect(controller._systemTimeInterval).toBeNull();
      expect(controller._modelIndicatorInterval).toBeNull();
    });

    it('creates logger with name TelemetryController', () => {
      const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
      controller = new TelemetryController();
      expect(createRendererLogger).toHaveBeenCalledWith('TelemetryController');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // start()
  // ═══════════════════════════════════════════════════════════════════════

  describe('start()', () => {
    it('creates 3 intervals', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      controller.start();

      expect(controller._telemetryInterval).not.toBeNull();
      expect(controller._systemTimeInterval).not.toBeNull();
      expect(controller._modelIndicatorInterval).not.toBeNull();
    });

    it('calls updateTelemetry immediately on start', () => {
      const elements = createElements();
      const aether = createMockAether();
      controller = new TelemetryController({ aether, elements });
      const spy = jest.spyOn(controller, 'updateTelemetry');
      controller.start();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('calls updateSystemTime immediately on start', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const spy = jest.spyOn(controller, 'updateSystemTime');
      controller.start();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('calls updateModelIndicator immediately on start', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const spy = jest.spyOn(controller, 'updateModelIndicator');
      controller.start();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('logs debug message on start', () => {
      controller = new TelemetryController();
      controller.start();
      expect(controller.log.debug).toHaveBeenCalledWith('Telemetry updates started');
    });

    it('telemetry interval fires every 1 second', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const spy = jest.spyOn(controller, 'updateTelemetry');
      controller.start();

      // Initial call
      expect(spy).toHaveBeenCalledTimes(1);

      // Advance 1s
      jest.advanceTimersByTime(1000);
      expect(spy).toHaveBeenCalledTimes(2);

      // Advance another 1s
      jest.advanceTimersByTime(1000);
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('systemTime interval fires every 1 second', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const spy = jest.spyOn(controller, 'updateSystemTime');
      controller.start();

      expect(spy).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1000);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('modelIndicator interval fires every 15 seconds', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const spy = jest.spyOn(controller, 'updateModelIndicator');
      controller.start();

      expect(spy).toHaveBeenCalledTimes(1);

      // 14 seconds — not yet fired again
      jest.advanceTimersByTime(14000);
      expect(spy).toHaveBeenCalledTimes(1);

      // 15th second — fires
      jest.advanceTimersByTime(1000);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('does not call updates when document is hidden', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const teleSpy = jest.spyOn(controller, 'updateTelemetry');
      const timeSpy = jest.spyOn(controller, 'updateSystemTime');
      const modelSpy = jest.spyOn(controller, 'updateModelIndicator');

      controller.start();

      // Initial calls happened (document.hidden is false)
      expect(teleSpy).toHaveBeenCalledTimes(1);
      expect(timeSpy).toHaveBeenCalledTimes(1);
      expect(modelSpy).toHaveBeenCalledTimes(1);

      // Set hidden
      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });

      // Advance 1s — telemetry and systemTime intervals fire but skip due to hidden
      jest.advanceTimersByTime(1000);
      expect(teleSpy).toHaveBeenCalledTimes(1); // No additional call
      expect(timeSpy).toHaveBeenCalledTimes(1);

      // Advance to 15s — modelIndicator also skips
      jest.advanceTimersByTime(14000);
      expect(modelSpy).toHaveBeenCalledTimes(1);
    });

    it('resumes updates when document becomes visible again', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const teleSpy = jest.spyOn(controller, 'updateTelemetry');

      controller.start();
      expect(teleSpy).toHaveBeenCalledTimes(1);

      // Hidden
      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
      jest.advanceTimersByTime(1000);
      expect(teleSpy).toHaveBeenCalledTimes(1);

      // Visible again
      Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
      jest.advanceTimersByTime(1000);
      expect(teleSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // updateTelemetry()
  // ═══════════════════════════════════════════════════════════════════════

  describe('updateTelemetry()', () => {
    it('renders CPU usage from aether stats', async () => {
      const elements = createElements();
      const aether = createMockAether({ cpu: { percent: 73 }, process: { memory: 1024 } });
      controller = new TelemetryController({ aether, elements });

      await controller.updateTelemetry();
      expect(elements.cpuUsage.textContent).toBe('73%');
    });

    it('renders memory usage in MB', async () => {
      const elements = createElements();
      const memBytes = 256 * 1024 * 1024; // 256 MB
      const aether = createMockAether({ cpu: { percent: 10 }, process: { memory: memBytes } });
      controller = new TelemetryController({ aether, elements });

      await controller.updateTelemetry();
      expect(elements.memoryUsage.textContent).toBe('256 MB');
    });

    it('rounds memory to nearest MB', async () => {
      const elements = createElements();
      const memBytes = 256.7 * 1024 * 1024;
      const aether = createMockAether({ cpu: { percent: 10 }, process: { memory: memBytes } });
      controller = new TelemetryController({ aether, elements });

      await controller.updateTelemetry();
      expect(elements.memoryUsage.textContent).toBe('257 MB');
    });

    it('handles null stats gracefully (no aether)', async () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      await controller.updateTelemetry();
      // Should not crash, elements should remain unchanged
      expect(elements.cpuUsage.textContent).toBe('');
    });

    it('handles aether without system gracefully', async () => {
      const elements = createElements();
      controller = new TelemetryController({ aether: {}, elements });

      await controller.updateTelemetry();
      expect(elements.cpuUsage.textContent).toBe('');
    });

    it('handles aether.system without getStats gracefully', async () => {
      const elements = createElements();
      controller = new TelemetryController({ aether: { system: {} }, elements });

      await controller.updateTelemetry();
      expect(elements.cpuUsage.textContent).toBe('');
    });

    it('renders FPS average from visualizer', async () => {
      const elements = createElements();
      const visualizer = createMockVisualizer({ fpsValues: [50, 60, 70] });
      controller = new TelemetryController({ visualizer, elements });

      await controller.updateTelemetry();
      expect(elements.fpsCounter.textContent).toBe('60');
    });

    it('renders FPS 60 when fpsValues is empty', async () => {
      const elements = createElements();
      const visualizer = createMockVisualizer({ fpsValues: [] });
      controller = new TelemetryController({ visualizer, elements });

      await controller.updateTelemetry();
      expect(elements.fpsCounter.textContent).toBe('60');
    });

    it('rounds FPS to integer', async () => {
      const elements = createElements();
      const visualizer = createMockVisualizer({ fpsValues: [59, 60, 61, 62] });
      controller = new TelemetryController({ visualizer, elements });

      await controller.updateTelemetry();
      // (59+60+61+62)/4 = 60.5 -> rounds to 61
      expect(elements.fpsCounter.textContent).toBe('61');
    });

    it('skips FPS when no visualizer', async () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      await controller.updateTelemetry();
      expect(elements.fpsCounter.textContent).toBe('');
    });

    it('skips FPS when no fpsCounter element', async () => {
      const elements = createElements();
      delete elements.fpsCounter;
      const visualizer = createMockVisualizer();
      controller = new TelemetryController({ visualizer, elements });

      await controller.updateTelemetry();
      // No crash
    });

    it('renders mic percentage from guru', async () => {
      const elements = createElements();
      const guru = createMockGuru({ audioLevel: 0.75 });
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.micPercentage.textContent).toBe('75%');
    });

    it('renders 0% mic when audioLevel is 0', async () => {
      const elements = createElements();
      const guru = createMockGuru({ audioLevel: 0 });
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.micPercentage.textContent).toBe('0%');
    });

    it('renders 0% mic when audioLevel is undefined', async () => {
      const elements = createElements();
      const guru = createMockGuru({ audioLevel: undefined });
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.micPercentage.textContent).toBe('0%');
    });

    it('rounds mic percentage', async () => {
      const elements = createElements();
      const guru = createMockGuru({ audioLevel: 0.333 });
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.micPercentage.textContent).toBe('33%');
    });

    it('renders system status from guru state', async () => {
      const elements = createElements();
      const guru = createMockGuru({ assistant: 'listening' });
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.systemStatus.textContent).toBe('LISTENING');
    });

    it('defaults system status to IDLE when assistant is falsy', async () => {
      const elements = createElements();
      const guru = createMockGuru({ assistant: '' });
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.systemStatus.textContent).toBe('IDLE');
    });

    it('sets status badge class based on assistant state', async () => {
      const elements = createElements();
      const guru = createMockGuru({ assistant: 'thinking' });
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.systemStatus.className).toContain('stat-value');
      expect(elements.systemStatus.className).toContain('status-badge');
      expect(elements.systemStatus.classList.contains('status-thinking')).toBe(true);
    });

    it('defaults status badge class to status-idle', async () => {
      const elements = createElements();
      const guru = createMockGuru({ assistant: null });
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.systemStatus.classList.contains('status-idle')).toBe(true);
    });

    it('renders network latency', async () => {
      const elements = createElements();
      const guru = createMockGuru();
      guru.lastPingTime = 42;
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.networkLatency.textContent).toBe('42ms');
    });

    it('skips latency when lastPingTime is undefined', async () => {
      const elements = createElements();
      const guru = createMockGuru();
      guru.lastPingTime = undefined;
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      expect(elements.networkLatency.textContent).toBe('');
    });

    it('renders latency 0ms when lastPingTime is 0', async () => {
      const elements = createElements();
      const guru = createMockGuru();
      guru.lastPingTime = 0;
      controller = new TelemetryController({ guru, elements });

      await controller.updateTelemetry();
      // 0 !== undefined -> renders
      expect(elements.networkLatency.textContent).toBe('0ms');
    });

    it('renders node count from visualizer', async () => {
      const elements = createElements();
      const visualizer = createMockVisualizer();
      visualizer.neuralNetwork.nodes = new Array(128);
      controller = new TelemetryController({ visualizer, elements });

      await controller.updateTelemetry();
      expect(elements.nodeCount.textContent).toBe('128');
    });

    it('renders 0 when neuralNetwork has no nodes', async () => {
      const elements = createElements();
      const visualizer = createMockVisualizer();
      visualizer.neuralNetwork.nodes = undefined;
      controller = new TelemetryController({ visualizer, elements });

      await controller.updateTelemetry();
      expect(elements.nodeCount.textContent).toBe('0');
    });

    it('skips node count when no neuralNetwork', async () => {
      const elements = createElements();
      const visualizer = createMockVisualizer();
      visualizer.neuralNetwork = null;
      controller = new TelemetryController({ visualizer, elements });

      await controller.updateTelemetry();
      expect(elements.nodeCount.textContent).toBe('');
    });

    it('handles missing elements gracefully', async () => {
      const aether = createMockAether();
      const guru = createMockGuru();
      const visualizer = createMockVisualizer();
      controller = new TelemetryController({ aether, guru, visualizer, elements: {} });

      // Should not crash
      await controller.updateTelemetry();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // updateSystemTime()
  // ═══════════════════════════════════════════════════════════════════════

  describe('updateSystemTime()', () => {
    it('renders time in HH:MM:SS format', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      // Set a known time: 14:05:09
      jest.setSystemTime(new Date(2026, 1, 9, 14, 5, 9));
      controller.updateSystemTime();

      expect(elements.systemTime.textContent).toBe('14:05:09');
    });

    it('pads single digit hours', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      jest.setSystemTime(new Date(2026, 1, 9, 3, 15, 30));
      controller.updateSystemTime();

      expect(elements.systemTime.textContent).toBe('03:15:30');
    });

    it('renders midnight as 00:00:00', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      jest.setSystemTime(new Date(2026, 1, 9, 0, 0, 0));
      controller.updateSystemTime();

      expect(elements.systemTime.textContent).toBe('00:00:00');
    });

    it('renders 23:59:59', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      jest.setSystemTime(new Date(2026, 1, 9, 23, 59, 59));
      controller.updateSystemTime();

      expect(elements.systemTime.textContent).toBe('23:59:59');
    });

    it('does nothing when systemTime element is missing', () => {
      controller = new TelemetryController({ elements: {} });
      // Should not crash
      controller.updateSystemTime();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // updateModelIndicator()
  // ═══════════════════════════════════════════════════════════════════════

  describe('updateModelIndicator()', () => {
    it('sets online status with model name from health response', async () => {
      const elements = createElements();
      const endpoint = createMockEndpoint({ model: 'lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit', status: 'ok' });
      controller = new TelemetryController({ endpoint, elements });

      await controller.updateModelIndicator();
      expect(elements.modelStatusDot.classList.contains('online')).toBe(true);
      expect(elements.modelName.textContent).toBe('Qwen3-4b-Instruct-2507-ML...');
      expect(elements.modelName.title).toBe('lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit');
    });

    it('sets online "Connected" when health.status ok but no model', async () => {
      const elements = createElements();
      const endpoint = createMockEndpoint({ status: 'ok' });
      controller = new TelemetryController({ endpoint, elements });

      await controller.updateModelIndicator();
      expect(elements.modelStatusDot.classList.contains('online')).toBe(true);
      expect(elements.modelName.textContent).toBe('Connected');
    });

    it('sets offline "Unavailable" when health has neither model nor ok status', async () => {
      const elements = createElements();
      const endpoint = createMockEndpoint({ status: 'error' });
      controller = new TelemetryController({ endpoint, elements });

      await controller.updateModelIndicator();
      expect(elements.modelStatusDot.classList.contains('offline')).toBe(true);
      expect(elements.modelName.textContent).toBe('Unavailable');
    });

    it('sets offline "No Connection" when no endpoint available', async () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      await controller.updateModelIndicator();
      expect(elements.modelStatusDot.classList.contains('offline')).toBe(true);
      expect(elements.modelName.textContent).toBe('No Connection');
    });


    it('sets offline "Offline" when getHealth throws', async () => {
      const elements = createElements();
      const endpoint = {
        getHealth: jest.fn().mockRejectedValue(new Error('network error')),
      };
      controller = new TelemetryController({ endpoint, elements });

      await controller.updateModelIndicator();
      expect(elements.modelStatusDot.classList.contains('offline')).toBe(true);
      expect(elements.modelName.textContent).toBe('Offline');
    });

    it('handles null health response', async () => {
      const elements = createElements();
      const endpoint = createMockEndpoint(null);
      // Override to return null
      endpoint.getHealth.mockResolvedValue(null);
      controller = new TelemetryController({ endpoint, elements });

      await controller.updateModelIndicator();
      expect(elements.modelStatusDot.classList.contains('offline')).toBe(true);
      expect(elements.modelName.textContent).toBe('Unavailable');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // setModelStatus()
  // ═══════════════════════════════════════════════════════════════════════

  describe('setModelStatus()', () => {
    it('sets model-status-dot className and adds status class', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      controller.setModelStatus('online', 'test-model');
      expect(elements.modelStatusDot.className).toContain('model-status-dot');
      expect(elements.modelStatusDot.classList.contains('online')).toBe(true);
    });

    it('resets className before adding status', () => {
      const elements = createElements();
      elements.modelStatusDot.className = 'old-class extra-class';
      controller = new TelemetryController({ elements });

      controller.setModelStatus('offline', 'test');
      expect(elements.modelStatusDot.classList.contains('old-class')).toBe(false);
      expect(elements.modelStatusDot.classList.contains('model-status-dot')).toBe(true);
      expect(elements.modelStatusDot.classList.contains('offline')).toBe(true);
    });

    it('sets modelName textContent from formatted name', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      controller.setModelStatus('online', 'lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit');
      expect(elements.modelName.textContent).toBe('Qwen3-4b-Instruct-2507-ML...');
    });

    it('sets modelName title to raw model name', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      controller.setModelStatus('online', 'lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit');
      expect(elements.modelName.title).toBe('lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit');
    });

    it('does not update modelName when modelName param is falsy', () => {
      const elements = createElements();
      elements.modelName.textContent = 'existing';
      controller = new TelemetryController({ elements });

      controller.setModelStatus('online', '');
      expect(elements.modelName.textContent).toBe('existing');

      controller.setModelStatus('online', null);
      expect(elements.modelName.textContent).toBe('existing');
    });

    it('handles missing elements gracefully', () => {
      controller = new TelemetryController({ elements: {} });
      // Should not crash
      controller.setModelStatus('online', 'model');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _formatModelName()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_formatModelName()', () => {
    beforeEach(() => {
      controller = new TelemetryController();
    });

    it('strips provider prefix', () => {
      expect(controller._formatModelName('lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit')).toBe('Qwen3-4b-Instruct-2507-ML...');
    });

    it('returns raw name when no slash', () => {
      expect(controller._formatModelName('gpt-4o')).toBe('gpt-4o');
    });

    it('handles multiple slashes (takes last segment)', () => {
      expect(controller._formatModelName('org/provider/model-name')).toBe('model-name');
    });

    it('truncates names longer than 28 chars', () => {
      const longName = 'a'.repeat(30);
      const result = controller._formatModelName(longName);
      expect(result).toBe('a'.repeat(25) + '...');
      expect(result.length).toBe(28);
    });

    it('does not truncate names at exactly 28 chars', () => {
      const exactName = 'a'.repeat(28);
      expect(controller._formatModelName(exactName)).toBe(exactName);
    });

    it('does not truncate names shorter than 28 chars', () => {
      expect(controller._formatModelName('short-model')).toBe('short-model');
    });

    it('returns falsy input as-is', () => {
      expect(controller._formatModelName('')).toBe('');
      expect(controller._formatModelName(null)).toBe(null);
      expect(controller._formatModelName(undefined)).toBe(undefined);
    });

    it('truncation applies after stripping prefix', () => {
      const longModel = 'a'.repeat(30);
      const result = controller._formatModelName(`provider/${longModel}`);
      expect(result).toBe('a'.repeat(25) + '...');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // stop()
  // ═══════════════════════════════════════════════════════════════════════

  describe('stop()', () => {
    it('clears all 3 intervals', () => {
      controller = new TelemetryController();
      controller.start();

      expect(controller._telemetryInterval).not.toBeNull();
      expect(controller._systemTimeInterval).not.toBeNull();
      expect(controller._modelIndicatorInterval).not.toBeNull();

      controller.stop();

      expect(controller._telemetryInterval).toBeNull();
      expect(controller._systemTimeInterval).toBeNull();
      expect(controller._modelIndicatorInterval).toBeNull();
    });

    it('is safe to call when not started', () => {
      controller = new TelemetryController();
      expect(() => controller.stop()).not.toThrow();
    });

    it('is safe to call twice', () => {
      controller = new TelemetryController();
      controller.start();
      controller.stop();
      expect(() => controller.stop()).not.toThrow();
    });

    it('stops telemetry updates after stop()', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const spy = jest.spyOn(controller, 'updateTelemetry');

      controller.start();
      const initialCalls = spy.mock.calls.length;

      controller.stop();
      jest.advanceTimersByTime(5000);

      // No additional calls after stop
      expect(spy).toHaveBeenCalledTimes(initialCalls);
    });

    it('stops systemTime updates after stop()', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const spy = jest.spyOn(controller, 'updateSystemTime');

      controller.start();
      const initialCalls = spy.mock.calls.length;

      controller.stop();
      jest.advanceTimersByTime(5000);

      expect(spy).toHaveBeenCalledTimes(initialCalls);
    });

    it('stops modelIndicator updates after stop()', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });
      const spy = jest.spyOn(controller, 'updateModelIndicator');

      controller.start();
      const initialCalls = spy.mock.calls.length;

      controller.stop();
      jest.advanceTimersByTime(30000);

      expect(spy).toHaveBeenCalledTimes(initialCalls);
    });

    // Quantitative: N=3 intervals created, M=3 intervals cleared
    it('lifecycle: N=3 created = M=3 cleared', () => {
      controller = new TelemetryController();

      const clearSpy = jest.spyOn(global, 'clearInterval');

      controller.start();
      const t1 = controller._telemetryInterval;
      const t2 = controller._systemTimeInterval;
      const t3 = controller._modelIndicatorInterval;

      controller.stop();

      expect(clearSpy).toHaveBeenCalledTimes(3);
      expect(clearSpy).toHaveBeenCalledWith(t1);
      expect(clearSpy).toHaveBeenCalledWith(t2);
      expect(clearSpy).toHaveBeenCalledWith(t3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // dispose()
  // ═══════════════════════════════════════════════════════════════════════

  describe('dispose()', () => {
    it('calls stop()', () => {
      controller = new TelemetryController();
      controller.start();
      const spy = jest.spyOn(controller, 'stop');

      controller.dispose();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('nulls all references', () => {
      const aether = createMockAether();
      const guru = createMockGuru();
      const visualizer = createMockVisualizer();
      const endpoint = createMockEndpoint();
      const elements = createElements();
      controller = new TelemetryController({ aether, guru, visualizer, endpoint, elements });

      controller.dispose();

      expect(controller.aether).toBeNull();
      expect(controller.guru).toBeNull();
      expect(controller.visualizer).toBeNull();
      expect(controller.endpoint).toBeNull();
      expect(controller.elements).toEqual({});
    });

    it('is safe to call twice', () => {
      controller = new TelemetryController();
      controller.start();
      controller.dispose();
      expect(() => controller.dispose()).not.toThrow();
    });

    it('is safe to call on never-started instance', () => {
      controller = new TelemetryController();
      expect(() => controller.dispose()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Edge cases & integration
  // ═══════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('start -> stop -> start restarts intervals', () => {
      const elements = createElements();
      controller = new TelemetryController({ elements });

      controller.start();
      const id1 = controller._telemetryInterval;
      controller.stop();
      controller.start();
      const id2 = controller._telemetryInterval;

      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).not.toBe(id2);
    });

    it('full lifecycle with all deps', async () => {
      const elements = createElements();
      const aether = createMockAether({ cpu: { percent: 50 }, process: { memory: 100 * 1024 * 1024 } });
      const guru = createMockGuru({ audioLevel: 0.5, assistant: 'processing' });
      guru.lastPingTime = 15;
      const visualizer = createMockVisualizer({ fpsValues: [55, 65] });
      const endpoint = createMockEndpoint({ model: 'test/model-v1', status: 'ok' });
      controller = new TelemetryController({ aether, guru, visualizer, endpoint, elements });

      jest.setSystemTime(new Date(2026, 1, 9, 10, 30, 45));
      controller.start();

      // Allow async to resolve
      await Promise.resolve();
      await Promise.resolve();

      expect(elements.cpuUsage.textContent).toBe('50%');
      expect(elements.memoryUsage.textContent).toBe('100 MB');
      expect(elements.fpsCounter.textContent).toBe('60');
      expect(elements.micPercentage.textContent).toBe('50%');
      expect(elements.systemStatus.textContent).toBe('PROCESSING');
      expect(elements.networkLatency.textContent).toBe('15ms');
      expect(elements.systemTime.textContent).toBe('10:30:45');
      expect(elements.modelName.textContent).toBe('model-v1');
      expect(elements.modelName.title).toBe('test/model-v1');

      controller.dispose();

      expect(controller.aether).toBeNull();
      expect(controller.guru).toBeNull();
      expect(controller._telemetryInterval).toBeNull();
    });
  });
});
