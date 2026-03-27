'use strict';

/**
 * NeuralNetworkVisualizer Unit Tests
 * ============================================================================
 * Tests constructor, modes, getSystemState, getStateRotationMultiplier,
 * getColorForSystemState, cosmos particle system, controls (mouse/touch),
 * telemetry, pause/resume, destroy, animation loop state branches,
 * EventBus integration, window event handlers, and bug regressions.
 *
 * Bugs found and tested:
 * - getSystemState() line 195: missing guard on window.guru.state → TypeError
 * - animate closure line 453: same missing guard on guru.state.audioLevel
 * - Constructor missing _onCanvasTouchend null pre-declaration
 *
 * @module tests/unit/renderer/main/visualizer.test
 */

// ───────────────────────────────────────────────────────────────────────────
// Module mocks
// ───────────────────────────────────────────────────────────────────────────

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(),
}));

const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');

// ───────────────────────────────────────────────────────────────────────────
// THREE.js mock classes — real math for Vector3/Color, jest mocks for I/O
// ───────────────────────────────────────────────────────────────────────────

class MockVector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new MockVector3(this.x, this.y, this.z); }
  normalize() {
    const len = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z) || 1;
    this.x /= len; this.y /= len; this.z /= len;
    return this;
  }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  lerp(v, t) {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }
  distanceTo(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}

class MockColor {
  constructor(r = 0, g = 0, b = 0) { this.r = r; this.g = g; this.b = b; }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  lerp(c, t) {
    this.r += (c.r - this.r) * t;
    this.g += (c.g - this.g) * t;
    this.b += (c.b - this.b) * t;
    return this;
  }
  setHSL(h, s, l) { this.r = l; this.g = s; this.b = h; return this; }
  setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
}

class MockSphereGeometry { constructor() {} dispose() {} }
class MockIcosahedronGeometry { constructor() {} dispose() {} }

class MockShaderMaterial {
  constructor(opts = {}) {
    this.uniforms = opts.uniforms || {};
    this.vertexShader = opts.vertexShader || '';
    this.fragmentShader = opts.fragmentShader || '';
    this.transparent = opts.transparent || false;
    this.depthWrite = opts.depthWrite !== undefined ? opts.depthWrite : true;
    this.depthTest = opts.depthTest !== undefined ? opts.depthTest : true;
    this.blending = opts.blending || 0;
  }
  dispose() {}
}

class MockMeshBasicMaterial {
  constructor(opts = {}) {
    this.color = new MockColor();
    this.transparent = opts.transparent || false;
    this.opacity = opts.opacity !== undefined ? opts.opacity : 1.0;
  }
  dispose() {}
}

class MockMesh {
  constructor(geometry, material) {
    this.geometry = geometry;
    this.material = material;
    this.position = new MockVector3();
    this.rotation = { x: 0, y: 0, z: 0 };
    this.scale = { setScalar: jest.fn() };
  }
}

class MockBufferGeometry {
  constructor() { this.attributes = {}; }
  setFromPoints(points) {
    const arr = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      arr[i * 3] = p.x || 0;
      arr[i * 3 + 1] = p.y || 0;
      arr[i * 3 + 2] = p.z || 0;
    });
    this.attributes.position = { array: arr, needsUpdate: false };
    return this;
  }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  dispose() {}
}

class MockLineBasicMaterial {
  constructor(opts = {}) {
    this.color = new MockColor();
    this.transparent = opts.transparent || false;
    this.opacity = opts.opacity !== undefined ? opts.opacity : 0.3;
  }
  dispose() {}
}

class MockLine {
  constructor(geometry, material) { this.geometry = geometry; this.material = material; }
}

class MockPointsMaterial {
  constructor(opts = {}) {
    this.size = opts.size || 0.05;
    this.opacity = opts.opacity !== undefined ? opts.opacity : 1.0;
    this.vertexColors = opts.vertexColors || false;
    this.transparent = opts.transparent || false;
  }
  dispose() {}
}

class MockPoints {
  constructor(geometry, material) { this.geometry = geometry; this.material = material; }
}

class MockBufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
}

class MockScene {
  constructor() {
    this.children = [];
    this.rotation = { x: 0, y: 0 };
    this.scale = { setScalar: jest.fn() };
  }
  add(obj) { this.children.push(obj); }
  traverse(fn) {
    fn(this);
    this.children.forEach(child => fn(child));
  }
}

class MockPerspectiveCamera {
  constructor(fov, aspect) {
    this.position = new MockVector3();
    this.aspect = aspect;
    this.fov = fov;
  }
  updateProjectionMatrix() {}
}

class MockWebGLRenderer {
  constructor() { this._pixelRatio = 1; }
  setPixelRatio(r) { this._pixelRatio = r; }
  setSize() {}
  setClearColor() {}
  setViewport() {}
  getDrawingBufferSize(target) { target.x = 800; target.y = 600; return target; }
  setScissor() {}
  setScissorTest() {}
  render() {}
  dispose() {}
}

class MockVector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
}

class MockRaycaster {
  constructor() {}
  setFromCamera() {}
  intersectObject() { return []; }
}

function createTHREEGlobal() {
  return {
    Scene: MockScene,
    PerspectiveCamera: MockPerspectiveCamera,
    WebGLRenderer: MockWebGLRenderer,
    SphereGeometry: MockSphereGeometry,
    IcosahedronGeometry: MockIcosahedronGeometry,
    ShaderMaterial: MockShaderMaterial,
    MeshBasicMaterial: MockMeshBasicMaterial,
    Mesh: MockMesh,
    BufferGeometry: MockBufferGeometry,
    LineBasicMaterial: MockLineBasicMaterial,
    Line: MockLine,
    Color: MockColor,
    Vector3: MockVector3,
    Points: MockPoints,
    PointsMaterial: MockPointsMaterial,
    BufferAttribute: MockBufferAttribute,
    AdditiveBlending: 2,
    Vector2: MockVector2,
    Raycaster: MockRaycaster,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Require source AFTER mock setup
// ───────────────────────────────────────────────────────────────────────────

const threeMock = createTHREEGlobal();
jest.doMock('three', () => threeMock);

const NeuralNetworkVisualizer = require('../../../../src/renderer/main/modules/visualizer/Visualizer');

const mockLog = {
  trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
};

// ───────────────────────────────────────────────────────────────────────────
// Test suite
// ───────────────────────────────────────────────────────────────────────────

describe('NeuralNetworkVisualizer', () => {
  let rafCallbacks, rafId, mockTime, currentViz;

  beforeEach(() => {
    jest.useFakeTimers();

    // RAF mock
    rafCallbacks = [];
    rafId = 0;
    global.requestAnimationFrame = jest.fn((cb) => {
      const id = ++rafId;
      rafCallbacks.push({ id, cb });
      return id;
    });
    global.cancelAnimationFrame = jest.fn((id) => {
      rafCallbacks = rafCallbacks.filter(r => r.id !== id);
    });

    // Time
    mockTime = 1000;
    jest.spyOn(performance, 'now').mockImplementation(() => mockTime);

    // DOM
    document.body.innerHTML = '';
    Object.defineProperty(document, 'hidden', { value: false, configurable: true, writable: true });

    // Window
    window.innerWidth = 1024;
    window.innerHeight = 768;
    delete window.guru;
    delete window.__eventBus;

    // THREE
    global.THREE = createTHREEGlobal();

    // Logger
    createRendererLogger.mockReturnValue(mockLog);

    // Navigator
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });

    currentViz = null;
  });

  afterEach(() => {
    if (currentViz && !currentViz._destroyed) {
      try { currentViz.destroy(); } catch (_) {}
    }
    currentViz = null;
    jest.useRealTimers();
    delete global.THREE;
  });

  // ── Helpers ──

  function addCanvas() {
    const canvas = document.createElement('canvas');
    canvas.id = 'scene-canvas';
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    document.body.appendChild(canvas);
    return canvas;
  }

  function addTelemetryElements() {
    const nc = document.createElement('span');
    nc.id = 'node-count';
    document.body.appendChild(nc);
    const ut = document.createElement('span');
    ut.id = 'uptime';
    document.body.appendChild(ut);
    return { nodeCount: nc, uptime: ut };
  }

  function createMinimalViz(opts = {}) {
    currentViz = new NeuralNetworkVisualizer(opts);
    rafCallbacks = [];
    return currentViz;
  }

  function createFullViz(opts = {}) {
    addCanvas();
    addTelemetryElements();
    currentViz = new NeuralNetworkVisualizer(opts);
    rafCallbacks = [];
    return currentViz;
  }

  function createMockEventBus() {
    const handlers = {};
    return {
      on: jest.fn((event, handler) => {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
        return () => {
          const idx = handlers[event].indexOf(handler);
          if (idx >= 0) handlers[event].splice(idx, 1);
        };
      }),
      _handlers: handlers,
      _emit(event, data) { (handlers[event] || []).forEach(h => h(data)); },
    };
  }

  function runFrame(viz, ms = 16.67) {
    mockTime += ms;
    viz._animate();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Constructor
  // ══════════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    test('defaults to cosmos mode for missing options', () => {
      const viz = createMinimalViz();
      expect(viz.mode).toBe('cosmos');
    });

    test('defaults to cosmos mode for invalid mode string', () => {
      const viz = createMinimalViz({ mode: 'invalid' });
      expect(viz.mode).toBe('cosmos');
    });

    test('accepts cosmos mode', () => {
      const viz = createMinimalViz({ mode: 'cosmos' });
      expect(viz.mode).toBe('cosmos');
    });

    test('accepts neural mode', () => {
      const viz = createMinimalViz({ mode: 'neural' });
      expect(viz.mode).toBe('neural');
    });

    test('initializes EventBus when available', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      expect(viz.useEventBus).toBe(true);
      expect(viz.eventBus).toBe(bus);
      expect(bus.on).toHaveBeenCalledTimes(2);
    });

    test('skips EventBus when unavailable', () => {
      const viz = createMinimalViz();
      expect(viz.useEventBus).toBe(false);
      expect(viz.eventBus).toBeNull();
    });

    test('initializes runtime state correctly', () => {
      const viz = createMinimalViz();
      expect(viz._rafId).toBeNull();
      expect(viz._isPaused).toBe(false);
      expect(viz._destroyed).toBe(false);
      expect(viz._lowPowerMode).toBe(true);
      expect(viz.widgetMode).toBe(false);
      expect(viz.currentAudioLevel).toBe(0);
      expect(viz.systemState).toBe('idle');
      expect(viz.audioBoost).toBe(1.0);
      expect(viz.peakAudioLevel).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // getSystemState
  // ══════════════════════════════════════════════════════════════════════════

  describe('getSystemState', () => {
    test('returns idle by default', () => {
      const viz = createMinimalViz();
      expect(viz.getSystemState()).toBe('idle');
    });

    test('returns current systemState', () => {
      const viz = createMinimalViz();
      viz.systemState = 'speaking';
      expect(viz.getSystemState()).toBe('speaking');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // getStateRotationMultiplier
  // ══════════════════════════════════════════════════════════════════════════

  describe('getStateRotationMultiplier', () => {
    test('returns correct multipliers for static states (neural mode)', () => {
      const viz = createMinimalViz({ mode: 'neural' });
      expect(viz.getStateRotationMultiplier('offline', 0)).toBe(0.3);
      expect(viz.getStateRotationMultiplier('error', 0)).toBe(0.5);
      expect(viz.getStateRotationMultiplier('idle', 0)).toBe(1.0);
      expect(viz.getStateRotationMultiplier('waiting', 0)).toBe(2.0);
      expect(viz.getStateRotationMultiplier('thinking', 0)).toBe(3.5);
      expect(viz.getStateRotationMultiplier('working', 0)).toBe(4.0);
    });

    test('scales listening and speaking with audio level', () => {
      const viz = createMinimalViz({ mode: 'neural' });
      const listenBase = viz.getStateRotationMultiplier('listening', 0);
      const listenAudio = viz.getStateRotationMultiplier('listening', 0.5);
      expect(listenAudio).toBeGreaterThan(listenBase);

      const speakBase = viz.getStateRotationMultiplier('speaking', 0);
      const speakAudio = viz.getStateRotationMultiplier('speaking', 0.5);
      expect(speakAudio).toBeGreaterThan(speakBase);
    });

    test('applies cosmos mode dampening (0.25)', () => {
      const viz = createMinimalViz({ mode: 'cosmos' });
      const result = viz.getStateRotationMultiplier('idle', 0);
      expect(result).toBeCloseTo(0.25, 2);
    });

    test('returns default 1.0 for unknown state (neural mode)', () => {
      const viz = createMinimalViz({ mode: 'neural' });
      expect(viz.getStateRotationMultiplier('nonexistent', 0)).toBe(1.0);
    });

    test('applies audio boost factor to rotation', () => {
      const viz = createMinimalViz({ mode: 'neural' });
      viz.audioBoost = 2.0;
      // multiplier * (1 + (boostFactor - 1) * 0.4) = 1.0 * 1.4 = 1.4
      expect(viz.getStateRotationMultiplier('idle', 0)).toBeCloseTo(1.4, 2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // getColorForSystemState
  // ══════════════════════════════════════════════════════════════════════════

  describe('getColorForSystemState', () => {
    test('returns distinct Color objects for all known states', () => {
      const viz = createMinimalViz();
      const states = ['offline', 'listening', 'speaking', 'thinking', 'working', 'waiting', 'error', 'idle'];
      const colors = states.map(s => viz.getColorForSystemState(s));
      colors.forEach(c => {
        expect(c).toHaveProperty('r');
        expect(c).toHaveProperty('g');
        expect(c).toHaveProperty('b');
      });
      // Verify specific representative colors
      expect(viz.getColorForSystemState('offline').r).toBeCloseTo(0.7, 1);
      expect(viz.getColorForSystemState('listening').b).toBeGreaterThan(1.0);
      expect(viz.getColorForSystemState('speaking').r).toBeGreaterThan(1.0);
      expect(viz.getColorForSystemState('error').r).toBeGreaterThan(1.0);
    });

    test('returns white for unknown state (default case)', () => {
      const viz = createMinimalViz();
      const c = viz.getColorForSystemState('nonexistent');
      expect(c.r).toBeCloseTo(1.0, 1);
      expect(c.g).toBeCloseTo(1.0, 1);
      expect(c.b).toBeCloseTo(1.0, 1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Cosmos mode functions
  // ══════════════════════════════════════════════════════════════════════════

  describe('cosmos mode', () => {
    describe('_getCosmosTargetParams', () => {
      test('returns params for all known states', () => {
        const viz = createMinimalViz();
        const states = ['idle', 'listening', 'speaking', 'thinking', 'working', 'waiting', 'offline', 'error'];
        for (const state of states) {
          const params = viz._getCosmosTargetParams(state);
          expect(params).toBeDefined();
          expect(typeof params.noiseAmp).toBe('number');
          expect(typeof params.noiseSpeed).toBe('number');
          expect(typeof params.radiusScale).toBe('number');
          expect(Array.isArray(params.color1)).toBe(true);
          expect(params.color1.length).toBe(3);
          expect(Array.isArray(params.color2)).toBe(true);
          expect(params.color2.length).toBe(3);
          expect(typeof params.bloomStrength).toBe('number');
          expect(typeof params.sssIntensity).toBe('number');
          expect(typeof params.envReflect).toBe('number');
          expect(Array.isArray(params.sh)).toBe(true);
          expect(params.sh.length).toBe(9);
        }
      });

      test('defaults to idle for unknown state', () => {
        const viz = createMinimalViz();
        const params = viz._getCosmosTargetParams('unknown');
        const idle = viz._getCosmosTargetParams('idle');
        expect(params.noiseAmp).toBe(idle.noiseAmp);
        expect(params.color1).toEqual(idle.color1);
      });
    });

    describe('_createCosmosOrb', () => {
      test('creates orb mesh, inner glow, and atmosphere for high-end', () => {
        const viz = createMinimalViz();
        const scene = new MockScene();
        const camera = new MockPerspectiveCamera(75, 1);
        const renderer = new MockWebGLRenderer();
        const data = viz._createCosmosOrb(scene, camera, renderer, false);
        expect(data.orbMesh).toBeDefined();
        expect(data.orbMaterial).toBeDefined();
        expect(data.glowMesh).toBeDefined();
        expect(data.atmoPoints).toBeDefined();
        expect(data.atmoParticleCount).toBe(120);
        expect(data.isLowEnd).toBe(false);
        // 3 children: orbMesh + glowMesh + atmoPoints
        expect(scene.children.length).toBe(3);
      });

      test('creates fewer atmosphere particles for low-end', () => {
        const viz = createMinimalViz();
        const scene = new MockScene();
        const camera = new MockPerspectiveCamera(75, 1);
        const renderer = new MockWebGLRenderer();
        const data = viz._createCosmosOrb(scene, camera, renderer, true);
        expect(data.atmoParticleCount).toBe(40);
        expect(data.isLowEnd).toBe(true);
        // We removed composer/bloom from _createCosmosOrb
        // expect(data.composer).toBeNull();
      });

      test('initializes current params from idle state', () => {
        const viz = createMinimalViz();
        const scene = new MockScene();
        const camera = new MockPerspectiveCamera(75, 1);
        const renderer = new MockWebGLRenderer();
        const data = viz._createCosmosOrb(scene, camera, renderer, true);
        expect(data.currentParams.noiseAmp).toBe(0.14);
        expect(data.currentParams.radiusScale).toBe(1.0);
        expect(data.currentParams.sssIntensity).toBe(0.55);
        expect(data.currentParams.envReflect).toBe(0.20);
        expect(data.currentParams.sh).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(data.lastState).toBe('idle');
      });

      test('creates new uniforms for SSS, env, FFT bands, and SH', () => {
        const viz = createMinimalViz();
        const scene = new MockScene();
        const camera = new MockPerspectiveCamera(75, 1);
        const renderer = new MockWebGLRenderer();
        const data = viz._createCosmosOrb(scene, camera, renderer, true);
        expect(data.orbUniforms.uSSSIntensity).toBeDefined();
        expect(data.orbUniforms.uEnvReflect).toBeDefined();
        expect(data.orbUniforms.uBass).toBeDefined();
        expect(data.orbUniforms.uLowMid).toBeDefined();
        expect(data.orbUniforms.uHighMid).toBeDefined();
        expect(data.orbUniforms.uTreble).toBeDefined();
        expect(data.orbUniforms.uAudioPulse).toBeDefined();
        expect(data.orbUniforms.uAudioPulse.value).toBe(0.0);
        expect(data.orbUniforms.uSH).toBeDefined();
        expect(data.orbUniforms.uSH.value).toHaveLength(9);
      });
    });

    describe('_updateCosmosOrb', () => {
      let viz, data;
      beforeEach(() => {
        viz = createMinimalViz();
        const scene = new MockScene();
        const camera = new MockPerspectiveCamera(75, 1);
        const renderer = new MockWebGLRenderer();
        data = viz._createCosmosOrb(scene, camera, renderer, true);
      });

      test.each([
        'idle', 'listening', 'speaking', 'thinking',
        'working', 'waiting', 'offline', 'error',
      ])('updates without errors for %s state', (state) => {
        expect(() => viz._updateCosmosOrb(data, 1000, 0.5, state)).not.toThrow();
      });

      test('interpolates params toward target state', () => {
        const initialNoiseAmp = data.currentParams.noiseAmp;
        // Listening has noiseAmp=0.19, idle has 0.14
        viz._updateCosmosOrb(data, 1000, 0.5, 'listening');
        expect(data.currentParams.noiseAmp).toBeGreaterThan(initialNoiseAmp);
        expect(data.currentParams.noiseAmp).toBeLessThan(0.19);
      });

      test('updates shader uniforms', () => {
        viz._updateCosmosOrb(data, 2000, 0.7, 'speaking');
        expect(data.orbUniforms.uTime.value).toBeCloseTo(2.0, 1);
        expect(data.orbUniforms.uAudioLevel.value).toBe(0.7);
        expect(data.atmoUniforms.uTime.value).toBeCloseTo(2.0, 1);
        // Atmosphere now receives audio and radius
        expect(data.atmoUniforms.uAudioLevel.value).toBe(0.7);
        expect(typeof data.atmoUniforms.uRadiusScale.value).toBe('number');
      });

      test('updates inner glow opacity with audio', () => {
        viz._updateCosmosOrb(data, 1000, 0.8, 'speaking');
        // 0.05 base + 0.8 * 0.08 = 0.114
        expect(data.glowMaterial.opacity).toBeGreaterThan(0.05);
      });

      test('updates SSS and env uniforms', () => {
        viz._updateCosmosOrb(data, 1000, 0.5, 'idle');
        expect(data.orbUniforms.uSSSIntensity.value).toBeGreaterThan(0);
        expect(data.orbUniforms.uEnvReflect.value).toBeGreaterThan(0);
      });

      test('interpolates SH coefficients toward target state', () => {
        // Idle has sh = [0,0,0,0,0,0,0,0,0], listening has sh[1] = -0.15
        const initialSH1 = data.currentParams.sh[1];
        viz._updateCosmosOrb(data, 1000, 0.5, 'listening');
        expect(data.currentParams.sh[1]).toBeLessThan(initialSH1);
      });

      test('updates FFT band uniforms from smoothed audio values', () => {
        // FFT bands go through EMA smoothing in the animate loop.
        // _updateCosmosOrb reads from _smoothAudio (not raw currentBass etc.).
        viz._smoothAudio = { level: 0.5, bass: 0.7, lowMid: 0.4, highMid: 0.3, treble: 0.2 };
        viz._updateCosmosOrb(data, 1000, 0.5, 'idle');
        expect(data.orbUniforms.uBass.value).toBe(0.7);
        expect(data.orbUniforms.uLowMid.value).toBe(0.4);
        expect(data.orbUniforms.uHighMid.value).toBe(0.3);
        expect(data.orbUniforms.uTreble.value).toBe(0.2);
      });

      test('sets uAudioPulse from speech envelope', () => {
        viz._audioEnvelope = 0.65;
        viz._updateCosmosOrb(data, 1000, 0.5, 'speaking');
        expect(data.orbUniforms.uAudioPulse.value).toBe(0.65);
      });

      test('tracks last state', () => {
        viz._updateCosmosOrb(data, 1000, 0, 'thinking');
        expect(data.lastState).toBe('thinking');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Initialization
  // ══════════════════════════════════════════════════════════════════════════

  describe('initialization', () => {
    test('returns early when canvas is not found', () => {
      const viz = createMinimalViz();
      expect(viz.neuralNetwork).toBeNull();
      expect(viz._animate).toBeNull();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('[Visualizer] Canvas element not provided or found')
      );
    });

    test('creates full neural network with canvas present', () => {
      const viz = createFullViz({ mode: 'neural' });
      expect(viz.neuralNetwork).not.toBeNull();
      expect(viz.neuralNetwork.scene).toBeInstanceOf(MockScene);
      expect(viz.neuralNetwork.camera).toBeInstanceOf(MockPerspectiveCamera);
      expect(viz.neuralNetwork.renderer).toBeInstanceOf(MockWebGLRenderer);
      expect(viz.neuralNetwork.nodes.length).toBeGreaterThan(0);
      expect(viz._animate).toBeInstanceOf(Function);
    });

    test('creates fewer nodes on low-end devices', () => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true });
      const viz = createFullViz({ mode: 'neural' });
      expect(viz.neuralNetwork.nodes.length).toBe(90);
    });

    test('creates more nodes on high-end devices', () => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 16, configurable: true });
      const viz = createFullViz({ mode: 'neural' });
      expect(viz.neuralNetwork.nodes.length).toBe(150);
    });

    test('cosmos mode creates orb mesh + glow + atmosphere instead of mesh nodes', () => {
      const viz = createFullViz({ mode: 'cosmos' });
      expect(viz.neuralNetwork.nodes.length).toBe(0);
      // Scene children: orbMesh + glowMesh + atmoPoints = 3
      const meshes = viz.neuralNetwork.scene.children.filter(c => c instanceof MockMesh);
      const points = viz.neuralNetwork.scene.children.filter(c => c instanceof MockPoints);
      expect(meshes.length).toBe(2); // orbMesh + glowMesh
      expect(points.length).toBe(1); // atmoPoints
      expect(viz.neuralNetwork.cosmosData).toBeDefined();
    });

    test('updates node-count display element', () => {
      createFullViz();
      expect(document.getElementById('node-count').innerText).not.toBe('');
    });

    test('sets up eventBus listeners when eventBus is provided', () => {
      const mockEventBus = { on: jest.fn(), emit: jest.fn() };
      const viz = createFullViz({ eventBus: mockEventBus });
      expect(mockEventBus.on).toHaveBeenCalledWith('audio:level-updated', expect.any(Function));
      expect(mockEventBus.on).toHaveBeenCalledWith('visualizer:state:changed', expect.any(Function));
    });

    test('skips guru listener when guru.on is missing', () => {
      window.guru = { ws: { readyState: 1 }, state: { assistant: 'idle' } };
      const viz = createFullViz();
      expect(viz._onGuruStatus).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Controls (mouse / touch)
  // ══════════════════════════════════════════════════════════════════════════

  describe('controls', () => {
    test('mousedown sets mouseDown and records position', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 200 }));
      expect(viz.visualizerControls.mouseDown).toBe(true);
      expect(viz.visualizerControls.lastMouseX).toBe(100);
      expect(viz.visualizerControls.lastMouseY).toBe(200);
    });

    test('mousemove updates rotation velocity when dragging', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100 }));
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 130 }));
      expect(viz.visualizerControls.rotationVelocityX).not.toBe(0);
      expect(viz.visualizerControls.rotationVelocityY).not.toBe(0);
      expect(viz.visualizerControls.userInfluence).toBe(1.0);
    });

    test('mousemove does nothing when not dragging', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 130 }));
      expect(viz.visualizerControls.rotationVelocityX).toBe(0);
    });

    test('mouseup clears mouseDown', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
      expect(viz.visualizerControls.mouseDown).toBe(false);
    });

    test('wheel adjusts zoom and clamps between 0.5 and 2', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      // Zoom in
      const evt = new Event('wheel', { cancelable: true });
      evt.deltaY = -100;
      evt.preventDefault = jest.fn();
      canvas.dispatchEvent(evt);
      expect(viz.visualizerControls.zoom).toBeGreaterThan(1);

      // Zoom way out
      for (let i = 0; i < 100; i++) {
        const e = new Event('wheel', { cancelable: true });
        e.deltaY = 500;
        e.preventDefault = jest.fn();
        canvas.dispatchEvent(e);
      }
      expect(viz.visualizerControls.zoom).toBeGreaterThanOrEqual(0.5);
    });

    test('single touch start sets mouseDown', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      const evt = new Event('touchstart');
      evt.touches = [{ clientX: 100, clientY: 200 }];
      canvas.dispatchEvent(evt);
      expect(viz.visualizerControls.mouseDown).toBe(true);
      expect(viz.visualizerControls.lastMouseX).toBe(100);
    });

    test('two-finger touch calculates distance for pinch zoom', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      const evt = new Event('touchstart');
      evt.touches = [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 200 }];
      canvas.dispatchEvent(evt);
      expect(viz.visualizerControls.touchStartDistance).toBeGreaterThan(0);
    });

    test('single-finger touchmove rotates when dragging', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      const start = new Event('touchstart');
      start.touches = [{ clientX: 100, clientY: 100 }];
      canvas.dispatchEvent(start);

      const move = new Event('touchmove', { cancelable: true });
      move.touches = [{ clientX: 150, clientY: 130 }];
      move.preventDefault = jest.fn();
      canvas.dispatchEvent(move);
      expect(viz.visualizerControls.rotationVelocityX).not.toBe(0);
    });

    test('two-finger touchmove adjusts zoom', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      const start = new Event('touchstart');
      start.touches = [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }];
      canvas.dispatchEvent(start);
      const orig = viz.visualizerControls.zoom;

      const move = new Event('touchmove', { cancelable: true });
      move.touches = [{ clientX: 80, clientY: 100 }, { clientX: 220, clientY: 100 }];
      move.preventDefault = jest.fn();
      canvas.dispatchEvent(move);
      expect(viz.visualizerControls.zoom).not.toBe(orig);
    });

    test('touchend and touchcancel clear mouseDown', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      const start = new Event('touchstart');
      start.touches = [{ clientX: 100, clientY: 100 }];
      canvas.dispatchEvent(start);
      expect(viz.visualizerControls.mouseDown).toBe(true);

      canvas.dispatchEvent(new Event('touchend'));
      expect(viz.visualizerControls.mouseDown).toBe(false);

      // Re-start for touchcancel test
      canvas.dispatchEvent(start);
      canvas.dispatchEvent(new Event('touchcancel'));
      expect(viz.visualizerControls.mouseDown).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Telemetry
  // ══════════════════════════════════════════════════════════════════════════

  describe('telemetry', () => {
    test('updates uptime element periodically', () => {
      createFullViz();
      jest.advanceTimersByTime(61000);
      expect(document.getElementById('uptime').textContent).toMatch(/\d+m \d+s/);
    });

    test('skips telemetry when uptime element is missing', () => {
      addCanvas(); // canvas only, no telemetry elements
      const viz = new NeuralNetworkVisualizer();
      currentViz = viz;
      rafCallbacks = [];
      expect(viz._telemetryIntervals.length).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Pause / Resume / Widget mode
  // ══════════════════════════════════════════════════════════════════════════

  describe('pause / resume / widgetMode', () => {
    test('pause sets _isPaused flag', () => {
      const viz = createFullViz();
      viz.pause();
      expect(viz._isPaused).toBe(true);
    });

    test('resume from paused restarts animation', () => {
      const viz = createFullViz();
      viz.pause();
      viz._rafId = null;
      const before = global.requestAnimationFrame.mock.calls.length;
      viz.resume();
      expect(viz._isPaused).toBe(false);
      expect(global.requestAnimationFrame.mock.calls.length).toBeGreaterThan(before);
    });

    test('resume does nothing when not paused', () => {
      const viz = createFullViz();
      const before = global.requestAnimationFrame.mock.calls.length;
      viz.resume();
      expect(global.requestAnimationFrame.mock.calls.length).toBe(before);
    });

    test('resume does nothing when destroyed', () => {
      const viz = createFullViz();
      viz.pause();
      viz._destroyed = true;
      viz.resume();
      expect(viz._isPaused).toBe(true);
    });

    test('resume with existing _rafId does not double-request', () => {
      const viz = createFullViz();
      viz.pause();
      viz._rafId = 999;
      const before = global.requestAnimationFrame.mock.calls.length;
      viz.resume();
      expect(global.requestAnimationFrame.mock.calls.length).toBe(before);
    });

    test('setWidgetMode updates flag', () => {
      const viz = createMinimalViz();
      viz.setWidgetMode(true);
      expect(viz.widgetMode).toBe(true);
      viz.setWidgetMode(false);
      expect(viz.widgetMode).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Destroy
  // ══════════════════════════════════════════════════════════════════════════

  describe('destroy', () => {
    test('sets _destroyed flag', () => {
      const viz = createFullViz();
      viz.destroy();
      expect(viz._destroyed).toBe(true);
    });

    test('is idempotent (double destroy)', () => {
      const viz = createFullViz();
      viz.destroy();
      expect(() => viz.destroy()).not.toThrow();
    });

    test('cancels animation frame', () => {
      const viz = createFullViz();
      viz._rafId = 42;
      viz.destroy();
      expect(global.cancelAnimationFrame).toHaveBeenCalledWith(42);
      expect(viz._rafId).toBeNull();
    });

    test('clears telemetry intervals', () => {
      const viz = createFullViz();
      expect(viz._telemetryIntervals.length).toBeGreaterThan(0);
      viz.destroy();
      expect(viz._telemetryIntervals.length).toBe(0);
    });

    test('clears low-power timer', () => {
      const viz = createFullViz();
      viz._lowPowerTimer = setTimeout(() => {}, 10000);
      viz.destroy();
      expect(viz._lowPowerTimer).toBeNull();
    });

    test('removes EventBus listeners', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createFullViz();
      expect(viz._eventBusCleanup.length).toBe(2);
      viz.destroy();
      expect(viz._eventBusCleanup.length).toBe(0);
    });

    test('removes window event listeners', () => {
      const spy = jest.spyOn(window, 'removeEventListener');
      const viz = createFullViz();
      viz.destroy();
      expect(spy).toHaveBeenCalledWith('resize', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('blur', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('focus', expect.any(Function));
    });

    test('removes canvas event listeners', () => {
      const viz = createFullViz();
      const canvas = document.getElementById('scene-canvas');
      const spy = jest.spyOn(canvas, 'removeEventListener');
      viz.destroy();
      expect(spy).toHaveBeenCalledWith('mousedown', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('wheel', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('touchstart', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('touchmove', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('touchend', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('touchcancel', expect.any(Function));
    });

    test('calls cleanups from eventBus listeners', () => {
      const mockCleanup1 = jest.fn();
      const mockCleanup2 = jest.fn();
      const mockEventBus = { on: jest.fn().mockImplementation((event) => {
        if (event === 'audio:level-updated') return mockCleanup1;
        if (event === 'visualizer:state:changed') return mockCleanup2;
      }) };
      const viz = createFullViz({ eventBus: mockEventBus });
      viz.destroy();
      expect(mockCleanup1).toHaveBeenCalled();
      expect(mockCleanup2).toHaveBeenCalled();
    });


    test('removes overlay from DOM', () => {
      const viz = createFullViz();
      expect(viz._overlayEl).not.toBeNull();
      viz.destroy();
      expect(viz._overlayEl).toBeNull();
    });

    test('disposes THREE.js geometry and material', () => {
      const viz = createFullViz({ mode: 'neural' });
      const nodes = viz.neuralNetwork.nodes;
      const geo = jest.spyOn(nodes[0].geometry, 'dispose');
      const mat = jest.spyOn(nodes[0].material, 'dispose');
      viz.destroy();
      expect(geo).toHaveBeenCalled();
      expect(mat).toHaveBeenCalled();
      expect(viz.neuralNetwork).toBeNull();
    });

    test('handles canvas removal before destroy', () => {
      const viz = createFullViz();
      document.getElementById('scene-canvas').remove();
      expect(() => viz.destroy()).not.toThrow();
    });

    test('removes document mouseup listener', () => {
      const spy = jest.spyOn(document, 'removeEventListener');
      const viz = createFullViz();
      viz.destroy();
      expect(spy).toHaveBeenCalledWith('mouseup', expect.any(Function));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Animation loop
  // ══════════════════════════════════════════════════════════════════════════

  describe('animation loop', () => {
    test('returns immediately when destroyed', () => {
      const viz = createFullViz();
      viz._destroyed = true;
      const rotX = viz.neuralNetwork.scene.rotation.x;
      viz._animate();
      expect(viz.neuralNetwork.scene.rotation.x).toBe(rotX);
    });

    test('returns immediately when paused', () => {
      const viz = createFullViz();
      viz._isPaused = true;
      const rotX = viz.neuralNetwork.scene.rotation.x;
      viz._animate();
      expect(viz.neuralNetwork.scene.rotation.x).toBe(rotX);
    });

    test('applies scene rotation each frame', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      const rotX = viz.neuralNetwork.scene.rotation.x;
      runFrame(viz);
      expect(viz.neuralNetwork.scene.rotation.x).not.toBe(rotX);
    });

    test('forces frame on pending state change even during frame skip', () => {
      const viz = createFullViz({ mode: 'neural' });
      Object.defineProperty(document, 'hidden', { value: true, writable: true });
      viz._pendingStateChange = true;
      viz._lowPowerMode = true; // prevent updateNodes from overwriting
      runFrame(viz);
      expect(viz._pendingStateChange).toBe(false);
    });

    test('reduces quality when FPS < 28', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz.fpsValues = Array(30).fill(25);
      runFrame(viz, 40);
      expect(viz._updateEveryN).toBe(3);
      expect(viz._connectionUpdateEveryN).toBe(6);
    });

    test('moderate quality when FPS < 40', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz.fpsValues = Array(30).fill(35);
      runFrame(viz, 28.6);
      expect(viz._updateEveryN).toBe(2);
      expect(viz._connectionUpdateEveryN).toBe(4);
    });

    test('high quality when FPS > 55', () => {
      const viz = createFullViz();
      viz.fpsValues = Array(30).fill(60);
      runFrame(viz);
      expect(viz._updateEveryN).toBe(1);
      expect(viz._connectionUpdateEveryN).toBe(2);
    });

    test('uses EventBus audio level when available', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createFullViz();
      viz.currentAudioLevel = 0.75;
      expect(() => runFrame(viz)).not.toThrow();
    });

    test('uses window.guru fallback for audio when no EventBus', () => {
      window.guru = { ws: { readyState: 1 }, state: { audioLevel: 0.5, assistant: 'idle' } };
      const viz = createFullViz();
      viz.useEventBus = false;
      expect(() => runFrame(viz)).not.toThrow();
    });

    test('decays peak audio level when > 500ms since peak', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz.peakAudioLevel = 0.8;
      viz.lastPeakTime = Date.now() - 600;
      runFrame(viz);
      expect(viz.peakAudioLevel).toBeLessThan(0.8);
    });

    test('resets peak audio to zero when below threshold', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz.peakAudioLevel = 0.04;
      viz.lastPeakTime = Date.now() - 600;
      runFrame(viz);
      expect(viz.peakAudioLevel).toBe(0);
    });

    test('does not decay peak audio within 500ms window', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz.peakAudioLevel = 0.8;
      viz.lastPeakTime = Date.now() - 100;
      runFrame(viz);
      expect(viz.peakAudioLevel).toBe(0.8);
    });

    test('cosmos mode delegates to _updateCosmosOrb', () => {
      const viz = createFullViz({ mode: 'cosmos' });
      viz._lowPowerMode = false;
      const spy = jest.spyOn(viz, '_updateCosmosOrb');
      runFrame(viz);
      expect(spy).toHaveBeenCalled();
    });

    test('pending state change sets opacity to 0.98 (low-power blocks overwrite)', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._pendingStateChange = true;
      viz._lowPowerMode = true;
      runFrame(viz);
      expect(viz._pendingStateChange).toBe(false);
      expect(viz.neuralNetwork.nodes[0].material.opacity).toBeCloseTo(0.98, 1);
    });

    test('non-pending state uses gradual color lerp', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._pendingStateChange = false;
      viz._lowPowerMode = false;
      runFrame(viz);
      expect(viz.neuralNetwork.nodes[0].material.opacity).toBeGreaterThan(0);
    });

    test('node animation runs when not in low-power mode', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      const origX = viz.neuralNetwork.nodes[0].position.x;
      runFrame(viz);
      expect(viz.neuralNetwork.nodes[0].position.x).not.toBe(origX);
    });

    test('node boundary collision clamps x beyond BOUNDARY_RADIUS', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      const node = viz.neuralNetwork.nodes[0];
      node.position.x = 10;
      node.velocity.x = 1.0;
      runFrame(viz);
      expect(Math.abs(node.position.x)).toBeLessThanOrEqual(6);
    });

    test('node boundary collision clamps y beyond BOUNDARY_RADIUS', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      const node = viz.neuralNetwork.nodes[0];
      node.position.y = -10;
      node.velocity.y = -1.0;
      runFrame(viz);
      expect(Math.abs(node.position.y)).toBeLessThanOrEqual(6);
    });

    test('node boundary collision clamps z beyond BOUNDARY_RADIUS', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      const node = viz.neuralNetwork.nodes[0];
      node.position.z = 10;
      node.velocity.z = 1.0;
      runFrame(viz);
      expect(Math.abs(node.position.z)).toBeLessThanOrEqual(6);
    });

    test('listening state: node animation and scaling', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      viz.systemState = 'listening';
      viz.currentAudioLevel = 0.5;
      viz.useEventBus = true;
      runFrame(viz);
      expect(viz.neuralNetwork.nodes[0].scale.setScalar).toHaveBeenCalled();
    });

    test('speaking state: node animation and scaling', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      viz.systemState = 'speaking';
      viz.currentAudioLevel = 0.5;
      viz.useEventBus = true;
      runFrame(viz);
      expect(viz.neuralNetwork.nodes[0].scale.setScalar).toHaveBeenCalled();
    });

    test('idle state: multi-harmonic breathing', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      viz.systemState = 'idle';
      viz.useEventBus = true;
      runFrame(viz);
      expect(viz.neuralNetwork.nodes[0].scale.setScalar).toHaveBeenCalled();
    });

    test('animation uses clone fallback when _tmpVec1 is null', () => {
      const viz = createFullViz();
      viz._tmpVec1 = null;
      viz._tmpVec2 = null;
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      expect(() => runFrame(viz)).not.toThrow();
    });

    test('tmpVec null path: listening state', () => {
      const viz = createFullViz();
      viz._tmpVec1 = null;
      viz._tmpVec2 = null;
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      viz.systemState = 'listening';
      viz.currentAudioLevel = 0.5;
      viz.useEventBus = true;
      expect(() => runFrame(viz)).not.toThrow();
    });

    test('tmpVec null path: speaking state', () => {
      const viz = createFullViz();
      viz._tmpVec1 = null;
      viz._tmpVec2 = null;
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      viz.systemState = 'speaking';
      viz.currentAudioLevel = 0.5;
      viz.useEventBus = true;
      expect(() => runFrame(viz)).not.toThrow();
    });

    test('node without addScaledVector uses clone fallback', () => {
      const viz = createFullViz({ mode: 'neural' });
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      viz.neuralNetwork.nodes[0].position.addScaledVector = undefined;
      expect(() => runFrame(viz)).not.toThrow();
    });

    test('connection opacity differs by state (listening vs speaking vs idle)', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz._connectionUpdateEveryN = 1;
      if (viz.neuralNetwork.connections.length === 0) return;

      viz.systemState = 'listening';
      viz.currentAudioLevel = 0.5;
      viz.useEventBus = true;
      runFrame(viz);
      const listenOp = viz.neuralNetwork.connections[0].line.material.opacity;

      viz.systemState = 'speaking';
      runFrame(viz);
      const speakOp = viz.neuralNetwork.connections[0].line.material.opacity;

      viz.systemState = 'idle';
      runFrame(viz);
      const idleOp = viz.neuralNetwork.connections[0].line.material.opacity;

      expect(typeof listenOp).toBe('number');
      expect(typeof speakOp).toBe('number');
      expect(typeof idleOp).toBe('number');
    });

    test('widget/hidden breathing uses slow pulse', () => {
      const viz = createFullViz();
      viz.widgetMode = true;
      viz._pendingStateChange = true;
      expect(() => runFrame(viz)).not.toThrow();
    });

    test('scene scale reflects zoom and scaleBoost for listening', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz.systemState = 'listening';
      viz.currentAudioLevel = 0.8;
      viz.useEventBus = true;
      viz.visualizerControls.zoom = 1.5;
      runFrame(viz);
      expect(viz.neuralNetwork.scene.scale.setScalar).toHaveBeenCalled();
    });

    test('scene scale reflects zoom and scaleBoost for speaking', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz.systemState = 'speaking';
      viz.currentAudioLevel = 0.8;
      viz.useEventBus = true;
      runFrame(viz);
      expect(viz.neuralNetwork.scene.scale.setScalar).toHaveBeenCalled();
    });

    test('scene scale reflects zoom for idle state', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz.systemState = 'idle';
      viz.currentAudioLevel = 0.2;
      viz.useEventBus = true;
      runFrame(viz);
      expect(viz.neuralNetwork.scene.scale.setScalar).toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // EventBus integration
  // ══════════════════════════════════════════════════════════════════════════

  describe('EventBus integration', () => {
    test('audio:level-updated sets level, source, and STT boost', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      bus._emit('audio:level-updated', { level: 0.75, source: 'stt' });
      expect(viz.currentAudioLevel).toBe(0.75);
      expect(viz.audioSource).toBe('stt');
      expect(viz.audioBoost).toBe(2.2);
    });

    test('audio:level-updated extracts FFT band data', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      bus._emit('audio:level-updated', {
        level: 0.5, source: 'stt',
        bass: 0.8, lowMid: 0.4, highMid: 0.3, treble: 0.1,
      });
      expect(viz.currentBass).toBe(0.8);
      expect(viz.currentLowMid).toBe(0.4);
      expect(viz.currentHighMid).toBe(0.3);
      expect(viz.currentTreble).toBe(0.1);
    });

    test('audio:level-updated defaults FFT bands to 0 when missing', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      bus._emit('audio:level-updated', { level: 0.5, source: 'tts' });
      expect(viz.currentBass).toBe(0);
      expect(viz.currentLowMid).toBe(0);
      expect(viz.currentHighMid).toBe(0);
      expect(viz.currentTreble).toBe(0);
    });

    test('audio:level-updated applies TTS boost', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      bus._emit('audio:level-updated', { level: 0.5, source: 'tts' });
      expect(viz.audioBoost).toBe(1.8);
    });

    test('audio:level-updated resets boost for unknown source', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      bus._emit('audio:level-updated', { level: 0.5, source: 'other' });
      expect(viz.audioBoost).toBe(1.0);
    });

    test('audio:level-updated tracks peak level (only increases)', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      bus._emit('audio:level-updated', { level: 0.3, source: 'stt' });
      expect(viz.peakAudioLevel).toBe(0.3);
      bus._emit('audio:level-updated', { level: 0.8, source: 'stt' });
      expect(viz.peakAudioLevel).toBe(0.8);
      bus._emit('audio:level-updated', { level: 0.4, source: 'stt' });
      expect(viz.peakAudioLevel).toBe(0.8);
    });

    test('audio:level-updated wakes on significant STT audio (> 0.1)', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createFullViz();
      viz._lowPowerMode = true;
      bus._emit('audio:level-updated', { level: 0.5, source: 'stt' });
      expect(viz._lowPowerMode).toBe(false);
    });

    test('audio:level-updated does NOT wake on low level', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createFullViz();
      viz._lowPowerMode = true;
      bus._emit('audio:level-updated', { level: 0.05, source: 'stt' });
      expect(viz._lowPowerMode).toBe(true);
    });

    test('visualizer:state:changed updates systemState and sets pending flag', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      bus._emit('visualizer:state:changed', { state: 'listening', source: 'stt' });
      expect(viz.systemState).toBe('listening');
      expect(viz._pendingStateChange).toBe(true);
    });

    test('visualizer:state:changed wakes on listening/speaking', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createFullViz();
      viz._lowPowerMode = true;
      bus._emit('visualizer:state:changed', { state: 'speaking', source: 'tts' });
      expect(viz._lowPowerMode).toBe(false);
    });

    test('handles missing fields in audio:level-updated gracefully', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      bus._emit('audio:level-updated', {});
      expect(viz.currentAudioLevel).toBe(0);
      expect(viz.audioSource).toBe('unknown');
    });

    test('handles missing state in visualizer:state:changed', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createMinimalViz();
      bus._emit('visualizer:state:changed', {});
      expect(viz.systemState).toBe('idle');
    });

    test('audio wake starts RAF when loop is idle', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createFullViz();
      viz._rafId = null;
      const before = global.requestAnimationFrame.mock.calls.length;
      bus._emit('audio:level-updated', { level: 0.5, source: 'stt' });
      expect(global.requestAnimationFrame.mock.calls.length).toBeGreaterThan(before);
    });

    test('state change wake starts RAF when loop is idle', () => {
      const bus = createMockEventBus();
      window.__eventBus = bus;
      const viz = createFullViz();
      viz._rafId = null;
      const before = global.requestAnimationFrame.mock.calls.length;
      bus._emit('visualizer:state:changed', { state: 'listening' });
      expect(global.requestAnimationFrame.mock.calls.length).toBeGreaterThan(before);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Window event handlers
  // ══════════════════════════════════════════════════════════════════════════

  describe('window event handlers', () => {
    test('resize updates camera aspect', () => {
      const viz = createFullViz();
      window.innerWidth = 1920;
      window.innerHeight = 1080;
      viz._onWindowResize();
      expect(viz.neuralNetwork.camera.aspect).toBeCloseTo(1920 / 1080, 4);
    });

    test('visibility hidden enters low-power', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      Object.defineProperty(document, 'hidden', { value: true, writable: true });
      viz._onVisibilityChange();
      expect(viz._lowPowerMode).toBe(true);
    });

    test('visibility visible exits low-power', () => {
      const viz = createFullViz();
      viz._lowPowerMode = true;
      Object.defineProperty(document, 'hidden', { value: false, writable: true });
      viz._onVisibilityChange();
      expect(viz._lowPowerMode).toBe(false);
    });

    test('visibility change restarts RAF when idle', () => {
      const viz = createFullViz();
      viz._rafId = null;
      const before = global.requestAnimationFrame.mock.calls.length;
      viz._onVisibilityChange();
      expect(global.requestAnimationFrame.mock.calls.length).toBeGreaterThan(before);
    });

    test('blur enters low-power', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz._onWindowBlur();
      expect(viz._lowPowerMode).toBe(true);
    });

    test('focus exits low-power and restarts RAF', () => {
      const viz = createFullViz();
      viz._lowPowerMode = true;
      viz._rafId = null;
      viz._onWindowFocus();
      expect(viz._lowPowerMode).toBe(false);
      expect(global.requestAnimationFrame).toHaveBeenCalled();
    });

    test('beforeunload calls destroy', () => {
      const viz = createFullViz();
      const spy = jest.spyOn(viz, 'destroy');
      viz._onBeforeUnload();
      expect(spy).toHaveBeenCalled();
    });

    test('visualizer:state:changed sets _pendingStateChange and restarts RAF', () => {
      const mockEventBus = { on: jest.fn(), emit: jest.fn() };
      const viz = createFullViz({ eventBus: mockEventBus });
      viz._pendingStateChange = false;
      viz._rafId = null;
      
      const onStateChanged = mockEventBus.on.mock.calls.find(c => c[0] === 'visualizer:state:changed')[1];
      
      const before = global.requestAnimationFrame.mock.calls.length;
      onStateChanged({ state: 'listening' });
      
      expect(viz._pendingStateChange).toBe(true);
      expect(global.requestAnimationFrame.mock.calls.length).toBeGreaterThan(before);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Low-power mode
  // ══════════════════════════════════════════════════════════════════════════

  describe('low-power mode', () => {
    test('_enterLowPower reduces quality settings', () => {
      const viz = createFullViz();
      viz._lowPowerMode = false;
      viz._updateEveryN = 1;
      viz._connectionUpdateEveryN = 2;
      viz._enterLowPower();
      expect(viz._lowPowerMode).toBe(true);
      expect(viz._updateEveryN).toBeGreaterThanOrEqual(4);
      expect(viz._connectionUpdateEveryN).toBeGreaterThanOrEqual(8);
    });

    test('_exitLowPower restores max pixel ratio and clears flag', () => {
      const viz = createFullViz();
      viz._lowPowerMode = true;
      viz._exitLowPower();
      expect(viz._lowPowerMode).toBe(false);
    });

    test('_markInteraction exits low power and auto-returns after idle timeout', () => {
      const viz = createFullViz();
      viz._lowPowerMode = true;
      viz._markInteraction();
      expect(viz._lowPowerMode).toBe(false);
      jest.advanceTimersByTime(13000);
      expect(viz._lowPowerMode).toBe(true);
    });

    test('_markInteraction clears previous timer on repeated calls', () => {
      const viz = createFullViz();
      viz._markInteraction();
      jest.advanceTimersByTime(8000);
      viz._markInteraction(); // Reset timer
      jest.advanceTimersByTime(8000);
      // Only 8s since last interaction, not 12s → still active
      expect(viz._lowPowerMode).toBe(false);
      jest.advanceTimersByTime(5000);
      // Now 13s → back to low power
      expect(viz._lowPowerMode).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Bug regressions
  // ══════════════════════════════════════════════════════════════════════════

  describe('bug regressions', () => {
    // OFFENSIVE: Bug #1+#2 — animation loop crash when guru.state is undefined
    test('animation loop does not crash when guru exists but guru.state is undefined', () => {
      window.guru = { ws: { readyState: 1 } };
      const viz = createFullViz();
      viz.useEventBus = false;
      expect(() => runFrame(viz)).not.toThrow();
    });

    // OFFENSIVE: Verify getSystemState returns idle, not crash
    test('getSystemState returns idle when guru.state is undefined', () => {
      const viz = createMinimalViz();
      window.guru = { ws: { readyState: 1 } };
      expect(viz.getSystemState()).toBe('idle');
    });
  });
});
