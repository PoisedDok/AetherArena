'use strict';

/**
 * @.architecture
 * 
 * Incoming: window.guru.state.assistant (status changes), window.guru.state.audioLevel (mic level), User interactions (mouse/touch drag, wheel zoom, window focus/blur) --- {system_state_types.assistant_status | dom_types.interaction_event, string | Event}
 * Processing: THREE.js rendering — neural/organic modes (90-150 mesh nodes, 2.5 distance connections) OR cosmos mode (IcosahedronGeometry + custom GLSL ShaderMaterial with finite-difference displaced normals, simplex noise + SH topology displacement, dual-layer iridescence, PBR-lite + SSS + env reflection + ACES tone mapping, 4-band FFT audio reactivity, inner glow sphere, audio-reactive atmosphere particles, UnrealBloomPass post-processing), continuous orbital motion (Lissajous curves, multi-harmonic breathing) with audio-reactive scaling, state-driven color mapping (8 states: offline/listening/speaking/thinking/working/waiting/error/idle), adaptive FPS-based optimization (auto-adjust pixelRatio 0.9-1.5, updateEveryN 1-4 frames, connectionUpdateEveryN 2-8 frames), low-power mode after 12s idle, frame skipping (3x hidden, 2x low-power/widget, 1x active) --- {5 jobs: JOB_INITIALIZE, JOB_GET_STATE, JOB_UPDATE_DOM_ELEMENT, JOB_EMIT_EVENT, JOB_DISPOSE}
 * Outgoing: Canvas render (60 FPS target) --- {render_output, canvas_frame}
 * 
 * 
 * @module renderer/main/modules/visualizer/Visualizer
 * 
 * NeuralNetworkVisualizer - JARVIS-style Interactive Visualization
 * ============================================================================
 * Production-ready THREE.js neural network visualization with:
 * - Continuous fluid motion with responsive interaction
 * - Audio-reactive scaling and movement
 * - Adaptive performance optimization
 * - Low-power idle mode
 * - State-based color transitions
 * - Interactive controls (drag, rotate, zoom)
 * - Widget mode support
 */

const { createRendererLogger } = require('../../../shared/utils/logger');
const THREE = require('three');
const {
  ORB_VERTEX_SHADER, ORB_FRAGMENT_SHADER,
  ATMO_VERTEX_SHADER, ATMO_FRAGMENT_SHADER,
  COSMOS_STATE_PARAMS,
} = require('./cosmos-shaders');

class NeuralNetworkVisualizer {
  /**
   * @param {Object} [options]
   * @param {string} [options.mode='cosmos'] - Visual style mode:
   *   'cosmos'  — premium orb (IcosahedronGeometry + GLSL shaders, simplex noise, Fresnel, bloom) [default]
   *   'neural'  — techy scattered node+connection mesh
   */
  constructor(options = {}) {
    this.log = createRendererLogger('Visualizer');
    this.mode = ['neural', 'cosmos'].includes(options.mode) ? options.mode : 'cosmos';
    this.canvasEl = options.canvas || null;
    this.nodeCountEl = options.nodeCountEl || null;
    this.uptimeEl = options.uptimeEl || null;

    // Performance tracking
    this.fpsValues = [];
    this.lastFrameTime = 0;
    this.sessionStartTime = Date.now();
    this.burstHistory = [];
    this.widgetMode = false;
    
    // Runtime controls
    this._rafId = null;
    this._isPaused = false;
    this._destroyed = false;
    this._telemetryIntervals = [];
    this._animate = null;
    
    // Event listeners for cleanup
    this._onWindowResize = null;
    this._onVisibilityChange = null;
    this._onBeforeUnload = null;
    this._onWindowBlur = null;
    this._onWindowFocus = null;
    this._onCanvasMousedown = null;
    this._onCanvasMousemove = null;
    this._onDocumentMouseup = null;
    this._onCanvasWheel = null;
    this._onCanvasTouchstart = null;
    this._onCanvasTouchmove = null;
    this._onCanvasTouchend = null;
    this._onGuruStatus = null;
    this._overlayEl = null;
    
    // EventBus integration
    this.eventBus = options.eventBus || window.__eventBus || null;
    this.useEventBus = !!this.eventBus;
    this._eventBusCleanup = [];
    
    // Audio state (EventBus or fallback)
    this.currentAudioLevel = 0;
    this.currentBass = 0;
    this.currentLowMid = 0;
    this.currentHighMid = 0;
    this.currentTreble = 0;
    this.systemState = 'idle';
    this.audioSource = 'unknown';
    this.audioBoost = 1.0;
    this.peakAudioLevel = 0;
    this.lastPeakTime = 0;

    // Audio smoothing: EMA-filtered bands + fast-attack/slow-release envelope
    // Raw FFT values are jittery frame-to-frame; smoothing reveals speech rhythm.
    this._smoothAudio = { level: 0, bass: 0, lowMid: 0, highMid: 0, treble: 0 };
    this._audioEnvelope = 0;  // Speech envelope: fast attack (0.35), slow release (0.06)
    
    if (this.useEventBus) {
      this.log.debug('[Visualizer] Using EventBus for audio levels');
      this._setupEventBusListeners();
    } else {
      this.log.warn('[Visualizer] EventBus unavailable, using window.guru.state fallback');
    }

    // Adaptive pacing controls
    this._frameCount = 0;
    this._updateEveryN = 1; // update heavy node math every N frames
    this._connectionUpdateEveryN = 2; // update connection geometry every N frames
    this._maxPixelRatio = 1.5; // will be set precisely during init
    this._currentPixelRatio = null;
    this._frameSkipCounter = 0;

    // Event-driven color refresh
    this._pendingStateChange = false;

    // Low-power idle mode
    this._lowPowerMode = true;
    this._lowPowerIdleMs = 12000; // after interaction, return to low-power
    this._lowPowerTimer = null;

    // Temp vectors to avoid per-frame allocations
    this._tmpVec1 = null;
    this._tmpVec2 = null;

    // Neural network objects
    this.neuralNetwork = null;

    // Initialize
    this.init();
    this.startTelemetryUpdates();
  }
  
  /**
   * Setup EventBus event listeners (handsfree mode support)
   * @private
   */
  _setupEventBusListeners() {
    if (!this.eventBus) return;
    
    // Listen to audio level updates (STT input + TTS output)
    this._eventBusCleanup.push(
      this.eventBus.on('audio:level-updated', ({ level, source, bass, lowMid, highMid, treble }) => {
        this.currentAudioLevel = level || 0;
        this.currentBass = bass || 0;
        this.currentLowMid = lowMid || 0;
        this.currentHighMid = highMid || 0;
        this.currentTreble = treble || 0;
        this.audioSource = source || 'unknown';
        // SMART boost: Controlled differentiation (rotation speed, not size)
        this.audioBoost = source === 'stt' ? 2.2 : (source === 'tts' ? 1.8 : 1.0);
        // Track peak levels for burst effects
        if (level > (this.peakAudioLevel || 0)) {
          this.peakAudioLevel = level;
          this.lastPeakTime = Date.now();
        }
        
        // Wake up on significant audio activity
        if (level > 0.1 && (source === 'stt' || source === 'tts')) {
          if (this._markInteraction) {
            this._markInteraction();
          }
          // Ensure animation loop is running for immediate visual feedback
          if (this._rafId === null && this._animate && !this._isPaused && !this._destroyed) {
            try {
              this._rafId = requestAnimationFrame(this._animate);
            } catch(e) {
              this.log.debug('Failed to requestAnimationFrame on audio level update', { error: e?.message || String(e) });
            }
          }
        }
      })
    );
    
    // Listen to visualizer state changes (listening/speaking/thinking)
    this._eventBusCleanup.push(
      this.eventBus.on('visualizer:state:changed', ({ state, source }) => {
        this.log.debug(`[Visualizer] State changed: ${this.systemState} → ${state} (source: ${source || 'unknown'})`);
        this.systemState = state || 'idle';
        this._pendingStateChange = true; // Force immediate color update
        
        // JARVIS-level: Wake up from low-power mode on STT/TTS activity
        if (state === 'listening' || state === 'speaking') {
          if (this._markInteraction) {
            this._markInteraction();
          }
          // Ensure animation loop is running for immediate visual feedback
          if (this._rafId === null && this._animate && !this._isPaused && !this._destroyed) {
            try {
              this._rafId = requestAnimationFrame(this._animate);
            } catch(e) {
              this.log.debug('Failed to requestAnimationFrame on audio level update', { error: e?.message || String(e) });
            }
          }
        }
      })
    );
  }

  /**
   * Initialize visualizer
   */
  init() {
    this.log.debug(`[Visualizer] Initializing Neural Network Visualization (mode: ${this.mode})...`);
    this.initializeThreeJS();
  }

  /**
   * Get current system state from guru
   * @returns {string}
   */
  getSystemState() {
    // With strict DI, we rely purely on EventBus for state updates
    // if EventBus isn't available, we return the cached state
    return this.systemState || 'idle';
  }

  /**
   * Initialize THREE.js scene
   */
  async initializeThreeJS() {
    const canvas = this.canvasEl || document.getElementById('scene-canvas');
    if (!canvas) {
      this.log.error('[Visualizer] Canvas element not provided or found');
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ 
      canvas: canvas, 
      alpha: true, 
      antialias: true, 
      powerPreference: 'high-performance', 
      preserveDrawingBuffer: false 
    });

    try { 
      canvas.style.willChange = 'transform'; 
    } catch (e) {
      this.log.debug('Failed to set canvas willChange style', { error: e?.message || String(e) });
    }

    // Initialize temp vectors after THREE is guaranteed
    try { 
      this._tmpVec1 = new THREE.Vector3(); 
      this._tmpVec2 = new THREE.Vector3(); 
    } catch (e) {
      this.log.error('Failed to initialize temp THREE.Vector3. Failing fast.', { error: e?.message || String(e) });
      return;
    }

    try {
      // Cap pixel ratio for performance on high-DPI displays
      const maxDevicePixelRatio = 1.5;
      const ratio = Math.min(window.devicePixelRatio || 1, maxDevicePixelRatio);
      renderer.setPixelRatio(ratio);
      this._maxPixelRatio = ratio;
      this._currentPixelRatio = ratio;
    } catch (e) {
      this.log.debug('Failed to set renderer pixel ratio', { error: e?.message || String(e) });
    }
    
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    
    const nodes = [];
    const connections = [];

    // --- CONFIG: Geometry (mode-dependent) ---
    // Reduce node count on low-end devices to save CPU/GPU
    const isLowEnd = (() => {
      try { 
        return navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4; 
      } catch(e) { 
        this.log.debug('Failed to get hardwareConcurrency, assuming high end', { error: e?.message || String(e) });
        return false; 
      }
    })();
    const isOrganic = this.mode === 'organic';
    const isCosmos = this.mode === 'cosmos';
    const nodeCount = isCosmos ? 0 : (isLowEnd ? (isOrganic ? 70 : 90) : (isOrganic ? 110 : 150));
    const SPHERE_RADIUS = isOrganic ? 2.6 : 3.5;
    const BOUNDARY_RADIUS = isOrganic ? 4.5 : 6;
    
    const nodeCountEl = this.nodeCountEl || document.getElementById('node-count');
    if (nodeCountEl) {
      // Cosmos: icosphere vertices + atmosphere particles (detail 6 = 40962, detail 4 = 2562)
      nodeCountEl.innerText = isCosmos ? (isLowEnd ? '2602' : '41082') : nodeCount;
    }
    
    // Create nodes
    const nodeSize = isOrganic ? 0.04 : 0.03;
    const nodeSegments = isOrganic ? 16 : 12;
    const baseOpacity = isOrganic ? 0.7 : 0.8;
    for (let i = 0; i < nodeCount; i++) {
      const geometry = new THREE.SphereGeometry(nodeSize, nodeSegments, nodeSegments);
      const material = new THREE.MeshBasicMaterial({ 
        color: isOrganic ? 0x88ccee : 0x00d4ff,
        transparent: true,
        opacity: baseOpacity
      });
      const node = new THREE.Mesh(geometry, material);
      
      // Organic mode: nodes distributed more uniformly on shell surface (less scattered)
      const radius = isOrganic
        ? SPHERE_RADIUS * (0.7 + Math.random() * 0.3)  // Shell distribution: 70-100% radius
        : SPHERE_RADIUS * Math.cbrt(Math.random());     // Volume distribution (original)
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      
      node.position.x = radius * Math.sin(phi) * Math.cos(theta);
      node.position.y = radius * Math.sin(phi) * Math.sin(theta);
      node.position.z = radius * Math.cos(phi);
      
      node.originalPosition = node.position.clone();
      node.burstFactor = Math.random();
      node.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.01, 
        (Math.random() - 0.5) * 0.01, 
        (Math.random() - 0.5) * 0.01
      );
      
      scene.add(node);
      nodes.push(node);
    }
    
    // Create connections (organic: fewer, shorter range, dimmer)
    const connDistThreshold = isOrganic ? 1.8 : 2.5;
    const connProbSkip = isOrganic ? 0.82 : 0.7;      // Higher = fewer connections
    const connBaseOpacity = isOrganic ? 0.15 : 0.3;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const distance = nodes[i].position.distanceTo(nodes[j].position);
        if (distance < connDistThreshold && Math.random() > connProbSkip) {
          const geometry = new THREE.BufferGeometry().setFromPoints([
            nodes[i].position, 
            nodes[j].position
          ]);
          const material = new THREE.LineBasicMaterial({ 
            color: isOrganic ? 0x88ccee : 0x00d4ff, 
            transparent: true, 
            opacity: connBaseOpacity 
          });
          const connection = new THREE.Line(geometry, material);
          scene.add(connection);
          connections.push({ line: connection, node1: nodes[i], node2: nodes[j] });
        }
      }
    }

    // Cosmos mode: premium orb with custom shaders + bloom pipeline
    let cosmosData = null;
    if (isCosmos) {
      cosmosData = this._createCosmosOrb(scene, camera, renderer, isLowEnd);
    }
    
    camera.position.z = 8;
    
    this.setupVisualizerControls(canvas, camera, scene);

    // Helpers for low-power switching
    const setPixelRatio = (r) => { 
      try { 
        renderer.setPixelRatio(r); 
      } catch(e) {
        this.log.debug('Failed to set renderer pixel ratio in helper', { error: e?.message || String(e) });
      } 
      this._currentPixelRatio = r; 
    };

    this._enterLowPower = () => {
      this._lowPowerMode = true;
      try { 
        setPixelRatio(Math.max(0.9, (this._currentPixelRatio || 1) - 0.1)); 
      } catch(e) {
        this.log.debug('Failed to set pixel ratio on enter low power', { error: e?.message || String(e) });
      }
      this._updateEveryN = Math.max(this._updateEveryN, 4);
      this._connectionUpdateEveryN = Math.max(this._connectionUpdateEveryN, 8);
    };

    this._exitLowPower = () => {
      this._lowPowerMode = false;
      try { 
        setPixelRatio(this._maxPixelRatio); 
      } catch(e) {
        this.log.debug('Failed to set pixel ratio on exit low power', { error: e?.message || String(e) });
      }
      // allow adaptive logic to bring N back down naturally
    };

    this._markInteraction = () => {
      this._exitLowPower();
      if (this._lowPowerTimer) { 
        try { 
          clearTimeout(this._lowPowerTimer); 
        } catch(e) {
          this.log.debug('Failed to clear low power timer', { error: e?.message || String(e) });
        } 
      }
      this._lowPowerTimer = setTimeout(() => this._enterLowPower(), this._lowPowerIdleMs);
    };
    
    // Enhanced control system for JARVIS-like interaction
    this.visualizerControls = {
      // Base rotation that never stops completely (cosmos = visible drift, organic = calmer, neural = default)
      // Cosmos: orbMesh.rotation handles primary spin; scene rotation adds camera-orbit parallax
      baseRotationX: isCosmos ? 0.0008 : (isOrganic ? 0.0006 : 0.001),
      baseRotationY: isCosmos ? 0.0015 : (isOrganic ? 0.0012 : 0.002),
      
      // User interaction influence (decays smoothly)
      userRotationX: 0,
      userRotationY: 0,
      userInfluence: 0, // 0-1, decays over time
      
      // Current rotation velocities
      rotationVelocityX: 0,
      rotationVelocityY: 0,
      
      // Mouse state
      mouseDown: false,
      lastMouseX: 0,
      lastMouseY: 0,
      
      // Fluid Drag (momentum)
      fluidDragVelocity: typeof THREE !== 'undefined' && THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 },
      fluidDragAccum: typeof THREE !== 'undefined' && THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 },
      
      // Raycaster state (for spatial intelligence)
      raycaster: typeof THREE !== 'undefined' && THREE.Raycaster ? new THREE.Raycaster() : null,
      mouseVector: typeof THREE !== 'undefined' && THREE.Vector2 ? new THREE.Vector2(-9999, -9999) : { x: -9999, y: -9999 }, // default offscreen
      raycastIntersection: typeof THREE !== 'undefined' && THREE.Vector3 ? new THREE.Vector3() : { x: 0, y: 0, z: 0, lerp: function(){} },
      raycastActive: 0.0,
      
      // Zoom and interaction (1.25 default = orb fills more of the viewport)
      zoom: 1.25,
      touchStartDistance: 0,
      
      // Smooth decay rates
      velocityDecay: 0.98,
      influenceDecay: 0.985,
      
      // Interaction responsiveness
      mouseSensitivity: 0.005,
      interactionBoost: 2.0,
      
      // Auto-rotation enhancement during system states
      stateMultiplier: 1.0
    };
    
    this.lastFrameTime = performance.now();
    
    // Animation loop
    const animate = () => {
      if (this._destroyed || this._isPaused) return;
      
      const now = performance.now();
      const deltaTime = now - this.lastFrameTime;
      this.lastFrameTime = now;
      this.fpsValues.push(1000 / deltaTime);
      if (this.fpsValues.length > 30) this.fpsValues.shift();
      this._frameCount++;

      // Lightweight frame skipping in low-power/widget/hidden states
      // BUT: never skip if we have a pending state change (critical UX feedback)
      // Cosmos mode: skip ONLY when hidden (GPU-bound — skipping visible frames just makes it choppy)
      const desiredSkip = isCosmos
        ? (document.hidden ? 3 : 1)
        : (document.hidden ? 3 : ((this._lowPowerMode || this.widgetMode) ? 2 : 1));
      this._frameSkipCounter = (this._frameSkipCounter + 1) % desiredSkip;
      if (this._frameSkipCounter !== 0 && !this._pendingStateChange) {
        this._rafId = requestAnimationFrame(animate);
        return;
      }

      // Adaptive pacing based on recent FPS
      const avgFps = this.fpsValues.length ? (this.fpsValues.reduce((a, b) => a + b) / this.fpsValues.length) : 60;
      if (avgFps < 28) {
        this._updateEveryN = 3;
        this._connectionUpdateEveryN = 6;
        try {
          this._currentPixelRatio = Math.max(0.9, (this._currentPixelRatio || 1) - 0.05);
          renderer.setPixelRatio(this._currentPixelRatio);
        } catch (e) {
          this.log.debug('Failed to set pixel ratio in adaptive pacing (down)', { error: e?.message || String(e) });
        }
      } else if (avgFps < 40) {
        this._updateEveryN = 2;
        this._connectionUpdateEveryN = 4;
        try {
          this._currentPixelRatio = Math.max(1.0, (this._currentPixelRatio || 1) - 0.02);
          renderer.setPixelRatio(this._currentPixelRatio);
        } catch (e) {
          this.log.debug('Failed to set pixel ratio in adaptive pacing (mid)', { error: e?.message || String(e) });
        }
      } else if (avgFps > 55) {
        this._updateEveryN = 1;
        this._connectionUpdateEveryN = 2;
        try {
          this._currentPixelRatio = Math.min(this._maxPixelRatio, (this._currentPixelRatio || 1) + 0.02);
          renderer.setPixelRatio(this._currentPixelRatio);
        } catch (e) {
          this.log.debug('Failed to set pixel ratio in adaptive pacing (up)', { error: e?.message || String(e) });
        }
      }
      
      // Strict DI: use cached audio level driven by EventBus
      let audioLevel = Math.min(this.currentAudioLevel, 1.0);

      // --- Audio smoothing: EMA on all channels + speech envelope ---
      // Raw FFT values jitter frame-to-frame. EMA (coefficient 0.18, ~5-frame
      // half-life) removes noise while preserving speech rhythm.
      const ema = 0.18;
      this._smoothAudio.level  += (audioLevel - this._smoothAudio.level) * ema;
      this._smoothAudio.bass   += (this.currentBass - this._smoothAudio.bass) * ema;
      this._smoothAudio.lowMid += (this.currentLowMid - this._smoothAudio.lowMid) * ema;
      this._smoothAudio.highMid += (this.currentHighMid - this._smoothAudio.highMid) * ema;
      this._smoothAudio.treble += (this.currentTreble - this._smoothAudio.treble) * ema;

      // Speech envelope: fast attack captures syllable onsets instantly,
      // slow release holds through natural pauses between words (~270ms decay).
      const envTarget = this._smoothAudio.level;
      const envRate = envTarget > this._audioEnvelope ? 0.35 : 0.06;
      this._audioEnvelope += (envTarget - this._audioEnvelope) * envRate;

      const systemState = this.getSystemState();
      
      const isListening = systemState === 'listening';
      
      // JARVIS-level: Decay peak audio level for burst effects
      if (this.peakAudioLevel > 0) {
        const timeSincePeak = Date.now() - (this.lastPeakTime || Date.now());
        if (timeSincePeak > 500) {
          this.peakAudioLevel *= 0.95; // Decay peak over time
          if (this.peakAudioLevel < 0.05) {
            this.peakAudioLevel = 0;
          }
        }
      }
      
      // Dynamic state multiplier for enhanced rotation during different states
      this.visualizerControls.stateMultiplier = this.getStateRotationMultiplier(systemState, audioLevel);
      
      // Apply continuous base rotation (never stops)
      const baseRotX = this.visualizerControls.baseRotationX * this.visualizerControls.stateMultiplier;
      const baseRotY = this.visualizerControls.baseRotationY * this.visualizerControls.stateMultiplier;
      
      // Decay user influence smoothly
      this.visualizerControls.userInfluence *= this.visualizerControls.influenceDecay;
      this.visualizerControls.rotationVelocityX *= this.visualizerControls.velocityDecay;
      this.visualizerControls.rotationVelocityY *= this.visualizerControls.velocityDecay;
      
      // Combine base rotation with user influence
      const finalRotX = baseRotX + (this.visualizerControls.rotationVelocityX * this.visualizerControls.userInfluence);
      const finalRotY = baseRotY + (this.visualizerControls.rotationVelocityY * this.visualizerControls.userInfluence);
      
      scene.rotation.x += finalRotX;
      scene.rotation.y += finalRotY;

      // Cosmos mode: update shader uniforms, render DIRECTLY (no bloom).
      // Bloom post-processing (EffectComposer) is intentionally DISABLED:
      //   1. Bloom framebuffers are opaque — they destroy canvas alpha, making
      //      the transparent desktop background into a solid dark rectangle.
      //   2. Bloom blurs the specular highlights that reveal surface displacement,
      //      causing the "milky, uniform" look that hides waviness.
      //   3. The orb's PBR-lite pipeline (SSS, Fresnel rim, specular, iridescence)
      //      already provides sufficient depth and glow without bloom.
      // The bloom infrastructure is kept for future opt-in via settings.
      if (isCosmos && cosmosData) {
        // Handle raycasting for spatial intelligence
        if (this.visualizerControls.raycastActive > 0 && this.visualizerControls.raycaster) {
          this.visualizerControls.raycaster.setFromCamera(this.visualizerControls.mouseVector, camera);
          
          // O(1) Mathematical Sphere Intersection (approx radius 1.8 * current scale)
          // Avoids expensive O(N) mesh intersection against 40k+ vertices
          if (!this.visualizerControls.mathSphere) {
            this.visualizerControls.mathSphere = new THREE.Sphere(scene.position, 1.8);
            this.visualizerControls.intersectTarget = new THREE.Vector3();
          }
          this.visualizerControls.mathSphere.center.copy(scene.position);
          this.visualizerControls.mathSphere.radius = 1.8 * scene.scale.x;
          
          const hit = this.visualizerControls.raycaster.ray.intersectSphere(
            this.visualizerControls.mathSphere, 
            this.visualizerControls.intersectTarget
          );
          
          if (hit) {
            // Smoothly move the intersection point
            this.visualizerControls.raycastIntersection.lerp(this.visualizerControls.intersectTarget, 0.2);
            cosmosData.orbUniforms.uMousePos.value.copy(this.visualizerControls.raycastIntersection);
            // Ramp up activity
            cosmosData.orbUniforms.uMouseActive.value += (1.0 - cosmosData.orbUniforms.uMouseActive.value) * 0.1;
          } else {
            // Decay activity if missed
            cosmosData.orbUniforms.uMouseActive.value *= 0.9;
          }
        } else {
          // Decay activity if inactive
          cosmosData.orbUniforms.uMouseActive.value *= 0.9;
        }

        const widgetScale = this.widgetMode ? 1.35 : 1.0;
        scene.scale.setScalar(this.visualizerControls.zoom * widgetScale);
        this._updateCosmosOrb(cosmosData, now, audioLevel, systemState);

        // Widget mode: force square aspect (CSS is 100vw × 100vw)
        if (this.widgetMode && camera.aspect !== 1.0) {
          camera.aspect = 1.0;
          camera.updateProjectionMatrix();
        }

        renderer.setScissorTest(false);
        renderer.render(scene, camera);

        this._rafId = requestAnimationFrame(animate);
        return;
      }
      
      // SMART audio-reactive scaling - SUBTLE movement, stays in bounds
      // Focus on speed/color/opacity for intensity, not excessive size changes
      let scaleBoost = 1.0;
      if (isListening) {
        // STT: Subtle tightening with audio (controlled)
        const sttPulse = Math.sin(now * 0.008) * 0.04 * audioLevel;
        scaleBoost = 1.0 + (audioLevel * 0.08) + sttPulse;  // Max ~1.15
      } else if (systemState === 'speaking') {
        // TTS: Subtle expansion with audio (controlled)
        const ttsPulse = Math.sin(now * 0.005) * 0.05 * audioLevel;
        scaleBoost = 1.0 + (audioLevel * 0.10) + ttsPulse;  // Max ~1.18
      } else {
        // Other states: Minimal scaling
        scaleBoost = 1.0 + (audioLevel * 0.05);
      }
      scene.scale.setScalar(scaleBoost * this.visualizerControls.zoom);

      const nodeColor = this.getColorForSystemState(systemState);
      
      // SMART breathing pulse: SUBTLE, stays in control
      let breathingPulse = 0;
      if (this.widgetMode || document.hidden || this._lowPowerMode) {
        breathingPulse = 0.10 + Math.sin(now * 0.002) * 0.08; // Slow breathing when not focused
      } else if (isListening) {
        // STT: FAST pulsing but controlled amplitude
        breathingPulse = 0.08 + Math.sin(now * 0.008) * 0.10 * (0.5 + audioLevel * 0.5);
      } else if (systemState === 'speaking') {
        // TTS: SMOOTH pulsing but controlled amplitude
        breathingPulse = 0.08 + Math.sin(now * 0.005) * 0.09 * (0.5 + audioLevel * 0.5);
      }
      
      // If a status event arrived, immediately refresh colors even in low-power
      if (this._pendingStateChange) {
        nodes.forEach((node) => {
          node.material.color.copy(nodeColor);
          // JARVIS-level: Dramatic opacity boost on state transitions
          node.material.opacity = 0.98;
          node._targetOpacity = isListening || systemState === 'speaking' ? 0.85 : 0.75;
        });
        connections.forEach((conn) => {
          conn.line.material.color.copy(nodeColor);
          conn.line.material.opacity = Math.min(0.75, conn.line.material.opacity * 2.0);
        });
        this._pendingStateChange = false;
      } else {
        // JARVIS-level: Faster color transitions during STT/TTS for responsiveness
        const colorLerpSpeed = (isListening || systemState === 'speaking') ? 0.18 : 0.08;
        nodes.forEach((node) => {
          node.material.color.lerp(nodeColor, colorLerpSpeed);
          // Decay opacity back to target with breathing pulse
          const targetOpacity = (node._targetOpacity || 0.75) + breathingPulse;
          node.material.opacity += (targetOpacity - node.material.opacity) * 0.08;
        });
      }
      
      // JARVIS-level node animation with intense STT/TTS differentiation
      const updateNodes = !this._lowPowerMode && (this._frameCount % this._updateEveryN) === 0;
      const isSpeaking = systemState === 'speaking';
      
      if (updateNodes) nodes.forEach((node, index) => {
        let velocityMultiplier = 1.0;
        const timeOffset = index * 0.1;
        const globalTime = Date.now() * 0.001;
        
        if (isListening) {
          // STT (LISTENING): SMART intensity through SPEED not excessive expansion
          const audioReactivity = 1.8 + (audioLevel * 1.5);
          velocityMultiplier = audioReactivity;
          
          // SUBTLE tightening - stay near original positions (0.92-0.98 range)
          const contractionPulse = Math.sin(globalTime * 3 + timeOffset) * audioLevel * 0.04;
          const contractionFactor = 0.95 - (audioLevel * 0.03) + contractionPulse;  // 0.92-0.98
          
          this._tmpVec1.copy(node.originalPosition).multiplyScalar(contractionFactor);
          node.position.lerp(this._tmpVec1, 0.10 + (audioLevel * 0.15));
          
          // FAST erratic movement for intensity (speed-based, not position-based)
          const erraticPulse = Math.sin(globalTime * 8 + timeOffset * 3) * audioLevel * 0.05;
          this._tmpVec2.copy(node.originalPosition).normalize().multiplyScalar(erraticPulse);
          node.velocity.add(this._tmpVec2);
          
          // Strong return force keeps nodes in bounds
          this._tmpVec1.subVectors(node.originalPosition, node.position).multiplyScalar(0.015);
          node.velocity.add(this._tmpVec1);
          node.velocity.multiplyScalar(0.90);
          
        } else if (isSpeaking) {
          // TTS (SPEAKING): SMART intensity through SPEED not excessive expansion
          const audioReactivity = 1.6 + (audioLevel * 1.3);
          velocityMultiplier = audioReactivity;
          
          // SUBTLE expansion - stay near original positions (1.02-1.08 range)
          const expansionWave = Math.sin(globalTime * 2.5 + timeOffset * 0.5) * audioLevel * 0.03;
          const expansionFactor = 1.02 + (audioLevel * 0.03) + expansionWave;  // 1.02-1.08
          
          this._tmpVec1.copy(node.originalPosition).multiplyScalar(expansionFactor);
          node.position.lerp(this._tmpVec1, 0.08 + (audioLevel * 0.12));
          
          // SMOOTH flowing waves for intensity (speed-based)
          const projectionWave = Math.sin(globalTime * 3 + timeOffset) * audioLevel * 0.04;
          this._tmpVec2.copy(node.originalPosition).normalize().multiplyScalar(projectionWave);
          node.velocity.add(this._tmpVec2);
          
          // Gentle return force maintains structure
          this._tmpVec1.subVectors(node.originalPosition, node.position).multiplyScalar(0.010);
          node.velocity.add(this._tmpVec1);
          node.velocity.multiplyScalar(0.92);
          
        } else {
          // IDLE/OTHER: Gentle continuous movement
          velocityMultiplier = 0.12;
          this._tmpVec1.subVectors(node.originalPosition, node.position).multiplyScalar(0.003);
          node.velocity.add(this._tmpVec1);
          node.velocity.multiplyScalar(0.96);
          
          // Lissajous orbital motion (3:2:5 frequency ratio × golden ratio phase offsets)
          // Irrational frequency ratios produce non-repeating, organic-looking paths
          this._tmpVec1.set(
            Math.sin(globalTime * 0.5 + timeOffset) * Math.cos(globalTime * 0.3 + timeOffset * 1.618) * 0.003,
            Math.cos(globalTime * 0.3 + timeOffset) * Math.sin(globalTime * 0.5 + timeOffset * 0.618) * 0.003,
            Math.sin(globalTime * 0.4 + timeOffset) * Math.cos(globalTime * 0.2 + timeOffset * 2.618) * 0.002
          );
          node.velocity.add(this._tmpVec1);
        }
        
        if (node.position.addScaledVector) {
          node.position.addScaledVector(node.velocity, velocityMultiplier);
        } else {
          node.position.add(node.velocity.clone().multiplyScalar(velocityMultiplier));
        }

        // Boundary collision with energy preservation
        if (Math.abs(node.position.x) > BOUNDARY_RADIUS) {
          node.velocity.x *= -0.9;
          node.position.x = Math.sign(node.position.x) * (BOUNDARY_RADIUS - 0.1);
        }
        if (Math.abs(node.position.y) > BOUNDARY_RADIUS) {
          node.velocity.y *= -0.9;
          node.position.y = Math.sign(node.position.y) * (BOUNDARY_RADIUS - 0.1);
        }
        if (Math.abs(node.position.z) > BOUNDARY_RADIUS) {
          node.velocity.z *= -0.9;
          node.position.z = Math.sign(node.position.z) * (BOUNDARY_RADIUS - 0.1);
        }
        
        // Smooth color transitions
        node.material.color.lerp(nodeColor, 0.12);
        
        // SMART node scaling: SUBTLE size, rely on other effects for intensity
        let finalScale = 1.0;
        if (isListening) {
          // STT: FAST sharp pulsing (frequency-based intensity, not size)
          const sttBreathing = Math.sin(globalTime * 4 + timeOffset * 2) * 0.12;  // Faster frequency
          const sttAudioScale = audioLevel * 0.15;  // Controlled amplitude
          const sttSpike = Math.sin(globalTime * 10 + timeOffset) * audioLevel * 0.08;  // Fast spikes
          finalScale = 1.0 + sttBreathing + sttAudioScale + sttSpike;  // Max ~1.35
        } else if (isSpeaking) {
          // TTS: SMOOTH flowing (frequency-based intensity, not size)
          const ttsBreathing = Math.sin(globalTime * 2.5 + timeOffset) * 0.10;  // Smooth frequency
          const ttsAudioScale = audioLevel * 0.12;  // Controlled amplitude
          const ttsWave = Math.sin(globalTime * 3.5 + timeOffset * 0.5) * audioLevel * 0.08;
          finalScale = 1.0 + ttsBreathing + ttsAudioScale + ttsWave;  // Max ~1.30
        } else {
          // IDLE: Multi-harmonic breathing (golden ratio frequency ratios for organic rhythm)
          // Frequencies: 1.0, 1.618 (PHI), 2.618 (PHI^2) — never exactly repeat
          const breathingEffect = (
            Math.sin(globalTime * 1.0 + timeOffset * 2) * 0.06 +
            Math.sin(globalTime * 1.618 + timeOffset * 3.236) * 0.03 +
            Math.sin(globalTime * 2.618 + timeOffset * 0.618) * 0.015
          );
          const audioScale = audioLevel * 0.05;
          finalScale = 1.0 + breathingEffect + audioScale;
        }
        node.scale.setScalar(Math.max(0.8, Math.min(1.5, finalScale)));  // Tighter bounds
        
        // SMART opacity: HIGH visibility for intensity (secondary effect)
        let finalOpacity = 0.65;
        if (isListening) {
          // STT: HIGH opacity with FAST flashing (speed-based intensity)
          const sttFlash = Math.sin(globalTime * 10 + timeOffset) * 0.12;  // Faster flash
          finalOpacity = 0.80 + audioLevel * 0.25 + sttFlash;  // High but controlled
        } else if (isSpeaking) {
          // TTS: HIGH opacity with SMOOTH pulsing
          const ttsPulse = Math.sin(globalTime * 3 + timeOffset * 0.5) * 0.10;
          finalOpacity = 0.78 + audioLevel * 0.22 + ttsPulse;  // High but controlled
        } else {
          // IDLE: Moderate opacity with gentle pulse
          finalOpacity = 0.65 + audioLevel * 0.15 + Math.sin(globalTime * 0.5 + timeOffset) * 0.08;
        }
        node.material.opacity = Math.max(0.4, Math.min(0.98, finalOpacity));  // Cap at 0.98
      });
      
      // SMART connection updates: HIGH activity through FREQUENCY not amplitude
      const updateConnections = !this._lowPowerMode && (this._frameCount % this._connectionUpdateEveryN) === 0;
      if (updateConnections) connections.forEach((conn, connIndex) => {
        const positions = conn.line.geometry.attributes.position.array;
        positions.set([conn.node1.position.x, conn.node1.position.y, conn.node1.position.z], 0);
        positions.set([conn.node2.position.x, conn.node2.position.y, conn.node2.position.z], 3);
        conn.line.geometry.attributes.position.needsUpdate = true;
        
        // SMART connection opacity: HIGH frequency for intensity, controlled amplitude
        const distance = conn.node1.position.distanceTo(conn.node2.position);
        const proximityFactor = Math.max(0, 1 - distance / 5);
        const globalTime = Date.now() * 0.001;
        const connOffset = connIndex * 0.05;
        
        let connectionOpacity = 0.20;
        if (isListening) {
          // STT: FAST flickering (10Hz frequency) but controlled amplitude
          const sttFlicker = Math.sin(globalTime * 10 + connOffset) * 0.10;
          const sttPulse = Math.sin(globalTime * 6 + connOffset * 2) * 0.08;
          connectionOpacity = (0.32 + audioLevel * 0.20 + sttFlicker + sttPulse) * proximityFactor;
        } else if (isSpeaking) {
          // TTS: SMOOTH flowing waves (3-4Hz frequency) but controlled amplitude
          const ttsWave = Math.sin(globalTime * 4 + connOffset) * 0.12;
          const ttsFlow = Math.sin(globalTime * 2.5 + connOffset * 0.5) * 0.08;
          connectionOpacity = (0.30 + audioLevel * 0.18 + ttsWave + ttsFlow) * proximityFactor;
        } else {
          // IDLE: Gentle pulsing
          const idlePulse = Math.sin(globalTime + connOffset) * 0.06;
          connectionOpacity = (0.20 + audioLevel * 0.15 + idlePulse) * proximityFactor;
        }
        
        conn.line.material.opacity = Math.max(0.08, Math.min(0.70, connectionOpacity));  // Tighter cap
        conn.line.material.color.lerp(conn.node1.material.color, 0.12);
      });
      
      renderer.render(scene, camera);
      this._rafId = requestAnimationFrame(animate);
    };

    // Store the loop so we can reliably resume after pause/minimize
    this._animate = animate;
    this._rafId = requestAnimationFrame(this._animate);
    
    // Resize handler (includes cosmos bloom composer resize)
    this._onWindowResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;

      if (this.widgetMode) {
        // CSS rule `body.widget-mode #scene-canvas` forces display to 100vw×100vw.
        // The renderer buffer MUST match (vw×vw) or the buffer-to-CSS mapping distorts.
        // If buffer is w×h but CSS displays w×w, the height squishes/stretches → oval orb.
        camera.aspect = 1.0;
        camera.updateProjectionMatrix();
        renderer.setSize(w, w);
      } else {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        // Resize handler
        if (isCosmos && cosmosData) {
          // Bloom composer resize removed
        }
      }
    };
    window.addEventListener('resize', this._onWindowResize, { passive: true });
    
    // Visibility handler
    this._onVisibilityChange = () => {
      // Never fully pause on visibility change; just switch power modes
      if (document.hidden) {
        if (this._enterLowPower) this._enterLowPower();
      } else {
        if (this._markInteraction) this._markInteraction();
      }
      // Ensure loop is running
      if (!this._rafId) {
        try { 
          this._rafId = requestAnimationFrame(this._animate || (() => {})); 
        } catch(e) { this.log.trace('[Visualizer] visibilitychange raf failed:', e?.message); }
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange, { passive: true });

    // Status updates are strictly driven by EventBus now

    // Defensive teardown on unload
    this._onBeforeUnload = () => {
      try { 
        this.destroy(); 
      } catch(e) { this.log.trace('[Visualizer] beforeunload destroy failed:', e?.message); }
    };
    window.addEventListener('beforeunload', this._onBeforeUnload);

    // Pause when window loses focus, resume on focus
    this._onWindowBlur = () => {
      // enter low-power instead of pausing
      if (this._enterLowPower) this._enterLowPower();
    };
    this._onWindowFocus = () => {
      // ramp back up automatically without requiring a click
      if (this._markInteraction) this._markInteraction();
      if (!this._rafId) {
        try { 
          this._rafId = requestAnimationFrame(this._animate || (() => {})); 
        } catch(e) { this.log.trace('[Visualizer] windowfocus raf failed:', e?.message); }
      }
    };
    window.addEventListener('blur', this._onWindowBlur, { passive: true });
    window.addEventListener('focus', this._onWindowFocus, { passive: true });
    
    this.neuralNetwork = { scene, camera, renderer, nodes, connections, cosmosData };
    this.log.debug(`[Visualizer] Neural Network Visualization initialized (mode: ${this.mode}, nodes: ${nodeCount}, connections: ${connections.length})`);
  }

  /**
   * Get rotation multiplier based on system state
   * @param {string} systemState
   * @param {number} audioLevel
   * @returns {number}
   */
  getStateRotationMultiplier(systemState, audioLevel) {
    // SMART rotation: HIGH speed for intensity (primary visual effect)
    // Cosmos: heavily dampened (particles animate internally), organic: calmer, neural: full
    const organicDampen = this.mode === 'cosmos' ? 0.25 : (this.mode === 'organic' ? 0.55 : 1.0);
    const baseMultiplier = {
      'offline': 0.3,
      'listening': (5.5 + audioLevel * 6.0) * organicDampen,
      'speaking': (4.5 + audioLevel * 5.0) * organicDampen,
      'thinking': 3.5 * organicDampen,
      'working': 4.0 * organicDampen,
      'waiting': 2.0 * organicDampen,
      'error': 0.5,
      'idle': 1.0 * organicDampen
    };
    
    // Apply audio boost to rotation (primary intensity mechanism)
    const multiplier = baseMultiplier[systemState] || 1.0;
    const boostFactor = this.audioBoost || 1.0;
    
    return multiplier * (1 + (boostFactor - 1) * 0.4);  // Focus boost on speed
  }

  /**
   * Get color for system state - JARVIS-level vibrant colors
   * @param {string} systemState
   * @returns {THREE.Color}
   */
  getColorForSystemState(systemState) {
    switch(systemState) {
      case 'offline': return new THREE.Color(0.7, 0.35, 1.0); // Vibrant Purple - backend offline
      case 'listening': return new THREE.Color(0, 0.95, 1.2); // INTENSE Electric Blue - absorbing STT input
      case 'speaking': return new THREE.Color(1.2, 0.68, 0); // POWERFUL Bright Orange - projecting TTS output
      case 'thinking': return new THREE.Color(0.15, 1.0, 1.1); // Bright Cyan - processing/thinking
      case 'working': return new THREE.Color(0.15, 1.0, 1.1); // Bright Cyan - processing/working
      case 'waiting': return new THREE.Color(1.2, 0.9, 0.1); // Bright Yellow - waiting
      case 'error': return new THREE.Color(1.3, 0.25, 0.25); // Intense Red - error
      case 'idle':
      default: return new THREE.Color(1.0, 1.0, 1.0); // Clean White - idle (online)
    }
  }

  // =========================================================================
  // COSMOS MODE — Premium AI orb with custom GLSL shaders + bloom
  // Architecture: mesh sphere (IcosahedronGeometry + ShaderMaterial) +
  //   inner glow sphere + atmosphere particles + EffectComposer bloom pipeline
  // All visual complexity runs on GPU via shaders. CPU updates ~6 uniforms/frame.
  // =========================================================================

  /**
   * Create cosmos orb visualization: mesh sphere with custom shaders,
   * inner glow, atmosphere particles, and optional bloom post-processing.
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {THREE.WebGLRenderer} renderer
   * @param {boolean} isLowEnd
   * @returns {Object} cosmosData
   */
  _createCosmosOrb(scene, camera, renderer, isLowEnd) {
    const initialState = COSMOS_STATE_PARAMS.idle;
    const orbRadius = 1.8;

    // --- 1. Core orb mesh (IcosahedronGeometry + custom ShaderMaterial) ---
    const orbDetail = isLowEnd ? 4 : 6;  // 2562 vs 40962 vertices (restored to 6 for perfectly smooth silhouette, analytical normals easily handle the vertex load)
    const orbGeometry = new THREE.IcosahedronGeometry(orbRadius, orbDetail);

    const orbUniforms = {
      uTime:             { value: 0.0 },
      uNoiseAmp:         { value: initialState.noiseAmp },
      uNoiseSpeed:       { value: initialState.noiseSpeed },
      uBreathScale:      { value: 1.0 },
      uRadiusScale:      { value: initialState.radiusScale },
      uAudioLevel:       { value: 0.0 },
      uAudioSens:        { value: initialState.audioSens },
      uColor1:           { value: new THREE.Color(...initialState.color1) },
      uColor2:           { value: new THREE.Color(...initialState.color2) },
      uFresnelPower:     { value: initialState.fresnelPower },
      uFlowSpeed:        { value: initialState.flowSpeed },
      uEmissiveIntensity: { value: initialState.emissiveIntensity },
      uSSSIntensity:     { value: initialState.sssIntensity },
      uEnvReflect:       { value: initialState.envReflect },
      uBass:             { value: 0.0 },
      uLowMid:           { value: 0.0 },
      uHighMid:          { value: 0.0 },
      uTreble:           { value: 0.0 },
      uAudioPulse:       { value: 0.0 },   // Smoothed speech envelope (fast attack / slow release)
      uAlphaBoost:       { value: 0.0 },   // 0.0 = translucent (normal), 1.0 = near-opaque (widget)
      uSH:               { value: [...initialState.sh] },
      uMousePos:         { value: new THREE.Vector3(0, 0, 0) }, // 3D intersection point on orb
      uMouseActive:      { value: 0.0 }, // 0.0 = inactive, 1.0 = active
      uFluidDrag:        { value: new THREE.Vector3(0, 0, 0) }, // Accumulated fluid surface momentum
    };

    const orbMaterial = new THREE.ShaderMaterial({
      uniforms: orbUniforms,
      vertexShader: ORB_VERTEX_SHADER,
      fragmentShader: ORB_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: true,
      depthTest: true,
    });

    const orbMesh = new THREE.Mesh(orbGeometry, orbMaterial);
    scene.add(orbMesh);

    // --- 2. Inner glow sphere (core warmth, additive — 60% of orb radius) ---
    const glowGeometry = new THREE.SphereGeometry(0.6, 16, 16);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(...initialState.color1),
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    scene.add(glowMesh);

    // --- 3. Atmosphere particles (spherical shell, soft circles) ---
    const atmoCount = isLowEnd ? 40 : 120;
    const atmoPositions = new Float32Array(atmoCount * 3);
    const atmoPhases = new Float32Array(atmoCount);

    for (let i = 0; i < atmoCount; i++) {
      const radius = 2.5 + Math.random() * 1.5;  // Shell from 2.5 to 4.0
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      atmoPositions[i * 3]     = radius * Math.sin(phi) * Math.cos(theta);
      atmoPositions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      atmoPositions[i * 3 + 2] = radius * Math.cos(phi);
      atmoPhases[i] = Math.random() * Math.PI * 2;
    }

    const atmoGeometry = new THREE.BufferGeometry();
    atmoGeometry.setAttribute('position', new THREE.BufferAttribute(atmoPositions, 3));
    atmoGeometry.setAttribute('aPhase', new THREE.BufferAttribute(atmoPhases, 1));

    const atmoUniforms = {
      uTime:        { value: 0.0 },
      uAtmoSize:    { value: isLowEnd ? 0.12 : 0.25 },
      uBreathScale: { value: 1.0 },
      uAtmoColor:   { value: new THREE.Color(...initialState.color1) },
      uAudioLevel:  { value: 0.0 },
      uRadiusScale: { value: initialState.radiusScale },
    };

    const atmoMaterial = new THREE.ShaderMaterial({
      uniforms: atmoUniforms,
      vertexShader: ATMO_VERTEX_SHADER,
      fragmentShader: ATMO_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    const atmoPoints = new THREE.Points(atmoGeometry, atmoMaterial);
    scene.add(atmoPoints);

    // --- 4. Bloom post-processing pipeline (REMOVED) ---
    // The UnrealBloomPass pipeline was previously instantiated here but bypassed
    // in the render loop. It has been eradicated to save memory and GPU overhead.

    // --- 5. Current interpolation state (lerped toward target each frame) ---
    const currentParams = {
      noiseAmp: initialState.noiseAmp,
      noiseSpeed: initialState.noiseSpeed,
      radiusScale: initialState.radiusScale,
      color1: [...initialState.color1],
      color2: [...initialState.color2],
      breathRate: initialState.breathRate,
      breathDepth: initialState.breathDepth,
      audioSens: initialState.audioSens,
      fresnelPower: initialState.fresnelPower,
      emissiveIntensity: initialState.emissiveIntensity,
      flowSpeed: initialState.flowSpeed,
      bloomStrength: initialState.bloomStrength,
      sssIntensity: initialState.sssIntensity,
      envReflect: initialState.envReflect,
      sh: [...initialState.sh],
    };

    const atmoParticleCount = atmoCount;

    this.log.debug(`[Visualizer] Cosmos orb created (detail=${orbDetail}, atmo=${atmoCount})`);

    return {
      orbMesh,
      orbMaterial,
      orbUniforms,
      glowMesh,
      glowMaterial,
      atmoPoints,
      atmoMaterial,
      atmoUniforms,
      atmoParticleCount,
      currentParams,
      lastState: 'idle',
      isLowEnd,
    };
  }

  /**
   * Get target cosmos parameters for a given AI state.
   * @param {string} systemState
   * @returns {Object} State parameter set from COSMOS_STATE_PARAMS
   */
  _getCosmosTargetParams(systemState) {
    return COSMOS_STATE_PARAMS[systemState] || COSMOS_STATE_PARAMS.idle;
  }

  /**
   * Update cosmos orb each frame: interpolate state params, update shader uniforms.
   * Zero per-vertex JS math — all visual complexity runs on GPU.
   * @param {Object} data - cosmosData from _createCosmosOrb
   * @param {number} now - performance.now() in ms
   * @param {number} audioLevel - 0-1 normalized
   * @param {string} systemState - current AI state
   */
  _updateCosmosOrb(data, now, audioLevel, systemState) {
    const t = now * 0.001;
    const { orbMesh, orbUniforms, atmoUniforms, glowMaterial, currentParams } = data;
    const target = this._getCosmosTargetParams(systemState);

    // --- Orbit rotation: audio-driven rhythmic motion ---
    // Y rotation accumulates per-frame instead of t*constant so speech audio
    // can modulate the rotation speed. During speaking, syllable onsets push
    // rotation faster; pauses let it slow — creating rhythmic parallax.
    // Base: 0.002 rad/frame (~0.12 rad/s at 60fps, same as previous constant).
    // Speaking boost: envelope * 0.008 → up to 5x rotation at speech peaks.
    // X tilt: amplitude modulated by envelope for dynamic precession during speech.
    const isAudioActive = systemState === 'speaking' || systemState === 'listening';
    const env = this._audioEnvelope;
    if (orbMesh) {
      const baseRotRate = 0.002;
      const audioRotBoost = isAudioActive ? env * 0.008 : 0;
      data._orbRotAccumY = (data._orbRotAccumY || 0) + baseRotRate + audioRotBoost;
      data._orbRotAccumX = (data._orbRotAccumX || 0) + 0.0008;  // steady X accumulator
      orbMesh.rotation.y = data._orbRotAccumY;
      orbMesh.rotation.x = Math.sin(data._orbRotAccumX) * (0.15 + (isAudioActive ? env * 0.10 : 0));
    }

    // Lerp rate: fast enough for responsive feel, slow enough for smooth transitions
    const lerpRate = 0.04;

    // Interpolate all scalar parameters toward target
    currentParams.noiseAmp         += (target.noiseAmp - currentParams.noiseAmp) * lerpRate;
    currentParams.noiseSpeed       += (target.noiseSpeed - currentParams.noiseSpeed) * lerpRate;
    currentParams.radiusScale      += (target.radiusScale - currentParams.radiusScale) * lerpRate;
    currentParams.breathRate       += (target.breathRate - currentParams.breathRate) * lerpRate;
    currentParams.breathDepth      += (target.breathDepth - currentParams.breathDepth) * lerpRate;
    currentParams.audioSens        += (target.audioSens - currentParams.audioSens) * lerpRate;
    currentParams.fresnelPower     += (target.fresnelPower - currentParams.fresnelPower) * lerpRate;
    currentParams.emissiveIntensity += (target.emissiveIntensity - currentParams.emissiveIntensity) * lerpRate;
    currentParams.flowSpeed        += (target.flowSpeed - currentParams.flowSpeed) * lerpRate;
    currentParams.bloomStrength    += (target.bloomStrength - currentParams.bloomStrength) * lerpRate;
    currentParams.sssIntensity     += (target.sssIntensity - currentParams.sssIntensity) * lerpRate;
    currentParams.envReflect       += (target.envReflect - currentParams.envReflect) * lerpRate;

    // Interpolate colors (per-channel)
    for (let c = 0; c < 3; c++) {
      currentParams.color1[c] += (target.color1[c] - currentParams.color1[c]) * lerpRate;
      currentParams.color2[c] += (target.color2[c] - currentParams.color2[c]) * lerpRate;
    }

    // Interpolate SH coefficients (per-coefficient)
    for (let s = 0; s < 9; s++) {
      currentParams.sh[s] += (target.sh[s] - currentParams.sh[s]) * lerpRate;
    }

    // Compute breathing scale (multi-harmonic for organic feel, from neural mode pattern)
    const br = currentParams.breathRate;
    const bd = currentParams.breathDepth;
    const breath = 1.0
      + Math.sin(t * br) * bd
      + Math.sin(t * br * 1.618) * bd * 0.4
      + Math.sin(t * br * 2.618) * bd * 0.2;

    // --- Update orb uniforms ---
    orbUniforms.uTime.value             = t;
    orbUniforms.uNoiseAmp.value         = currentParams.noiseAmp;

    // Dynamic noise speed: waves accelerate during speech, slow during silence.
    // Audio envelope adds up to 0.35 to base noiseSpeed during speaking/listening.
    // At speaking base 0.48 + peak envelope: 0.83 → waves cross in ~4s (energetic).
    // During silence (envelope → 0): reverts to base → waves cross in ~9s (calm).
    const noiseSpeedAudioBoost = isAudioActive ? env * 0.35 : 0;
    orbUniforms.uNoiseSpeed.value       = currentParams.noiseSpeed + noiseSpeedAudioBoost;

    orbUniforms.uBreathScale.value      = breath;
    orbUniforms.uRadiusScale.value      = currentParams.radiusScale;
    orbUniforms.uAudioLevel.value       = audioLevel;
    orbUniforms.uAudioSens.value        = currentParams.audioSens;
    orbUniforms.uColor1.value.setRGB(currentParams.color1[0], currentParams.color1[1], currentParams.color1[2]);
    orbUniforms.uColor2.value.setRGB(currentParams.color2[0], currentParams.color2[1], currentParams.color2[2]);
    orbUniforms.uFresnelPower.value     = currentParams.fresnelPower;
    orbUniforms.uFlowSpeed.value        = currentParams.flowSpeed;
    orbUniforms.uEmissiveIntensity.value = currentParams.emissiveIntensity;
    orbUniforms.uSSSIntensity.value     = currentParams.sssIntensity;
    orbUniforms.uEnvReflect.value       = currentParams.envReflect;

    // --- Update FFT band uniforms (smoothed, not raw) ---
    // EMA-filtered values remove frame-to-frame jitter, revealing speech rhythm.
    orbUniforms.uBass.value             = this._smoothAudio.bass;
    orbUniforms.uLowMid.value           = this._smoothAudio.lowMid;
    orbUniforms.uHighMid.value          = this._smoothAudio.highMid;
    orbUniforms.uTreble.value           = this._smoothAudio.treble;

    // Speech envelope: drives wave amplitude modulation and lighting rhythm
    orbUniforms.uAudioPulse.value       = env;

    // --- Widget mode alpha boost (prevents desktop wallpaper bleed-through) ---
    orbUniforms.uAlphaBoost.value       = this.widgetMode ? 1.0 : 0.0;

    // --- Update SH coefficients (topology shapeshifting) ---
    for (let s = 0; s < 9; s++) {
      orbUniforms.uSH.value[s] = currentParams.sh[s];
    }

    // --- Update atmosphere uniforms ---
    // Atmosphere particles expand/contract more dramatically during speech.
    // Envelope boost: particles jitter 1x-2.5x during active speech peaks.
    const atmoAudioBoost = isAudioActive ? (1.0 + env * 1.5) : 1.0;
    atmoUniforms.uTime.value        = t;
    atmoUniforms.uBreathScale.value = breath;
    atmoUniforms.uAudioLevel.value  = audioLevel * atmoAudioBoost;
    atmoUniforms.uRadiusScale.value = currentParams.radiusScale;
    atmoUniforms.uAtmoColor.value.setRGB(
      currentParams.color1[0] * 0.8 + 0.15,
      currentParams.color1[1] * 0.8 + 0.15,
      currentParams.color1[2] * 0.8 + 0.15
    );

    // --- Update inner glow (core warmth, pulsing with audio) ---
    glowMaterial.color.setRGB(currentParams.color1[0], currentParams.color1[1], currentParams.color1[2]);
    glowMaterial.opacity = 0.05 + audioLevel * 0.08;

    // --- Gaze Tracking (core shifting toward mouse) ---
    if (orbUniforms.uMouseActive.value > 0.01 && data.glowMesh) {
      if (!data._glowTarget) data._glowTarget = new THREE.Vector3();
      // uMousePos is in world space, convert to local scene space
      data._glowTarget.copy(orbUniforms.uMousePos.value);
      data.glowMesh.parent.worldToLocal(data._glowTarget);
      
      // Keep glow inside the orb by normalizing and clamping length to ~0.4
      data._glowTarget.normalize().multiplyScalar(0.4 * orbUniforms.uMouseActive.value);
      data.glowMesh.position.lerp(data._glowTarget, 0.08);
    } else if (data.glowMesh) {
      // Gently return to center when inactive
      data.glowMesh.position.multiplyScalar(0.92);
    }

    data.lastState = systemState;
    
    // --- Fluid Drag physics ---
    if (this.visualizerControls && this.visualizerControls.fluidDragVelocity && this.visualizerControls.fluidDragVelocity.x !== undefined) {
      this.visualizerControls.fluidDragVelocity.multiplyScalar(0.95); // Friction/decay
      this.visualizerControls.fluidDragAccum.add(this.visualizerControls.fluidDragVelocity);
      orbUniforms.uFluidDrag.value.copy(this.visualizerControls.fluidDragAccum);
    }
  }

  /**
   * Setup visualizer controls (mouse/touch interaction)
   * @param {HTMLCanvasElement} canvas
   * @param {THREE.Camera} camera
   * @param {THREE.Scene} scene
   */
  setupVisualizerControls(canvas, camera, scene) {
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.zIndex = '0';
    canvas.style.pointerEvents = 'auto';
    
    const overlay = document.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.zIndex = '1';
    overlay.style.pointerEvents = 'none';
    document.body.appendChild(overlay);
    this._overlayEl = overlay;

    // Cache the canvas bounding rect to prevent layout thrashing on mousemove
    this._cachedCanvasRect = canvas.getBoundingClientRect();
    this._onVisualizerResize = () => {
      if (document.body.contains(canvas)) {
        this._cachedCanvasRect = canvas.getBoundingClientRect();
      }
    };
    window.addEventListener('resize', this._onVisualizerResize, { passive: true });
    
    // Optional: Update rect when scrolling if the canvas is not fixed
    window.addEventListener('scroll', this._onVisualizerResize, { passive: true, capture: true });

    // Mouse drag to rotate
    this._onCanvasMousedown = (e) => {
      this.visualizerControls.mouseDown = true;
      this.visualizerControls.lastMouseX = e.clientX;
      this.visualizerControls.lastMouseY = e.clientY;
      
      // Initialize mouseVector if needed so we don't crash before mousemove
      const rect = this._cachedCanvasRect;
      this.visualizerControls.mouseVector.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.visualizerControls.mouseVector.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.visualizerControls.raycastActive = 1.0;
      
      this._markInteraction();
    };
    canvas.addEventListener('mousedown', this._onCanvasMousedown);

    this._onCanvasMousemove = (e) => {
      // Update raycaster mouse vector
      const rect = this._cachedCanvasRect;
      this.visualizerControls.mouseVector.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.visualizerControls.mouseVector.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.visualizerControls.raycastActive = 1.0;

      if (!this.visualizerControls.mouseDown) return;
      
      const deltaX = e.clientX - this.visualizerControls.lastMouseX;
      const deltaY = e.clientY - this.visualizerControls.lastMouseY;
      
      // Enhanced velocity calculation with interaction boost
      this.visualizerControls.rotationVelocityX += deltaY * this.visualizerControls.mouseSensitivity * this.visualizerControls.interactionBoost;
      this.visualizerControls.rotationVelocityY += deltaX * this.visualizerControls.mouseSensitivity * this.visualizerControls.interactionBoost;
      
      // Full influence during active dragging
      this.visualizerControls.userInfluence = 1.0;
      
      if (this.visualizerControls.fluidDragVelocity && this.visualizerControls.fluidDragVelocity.x !== undefined) {
        // Translate swipe vector to spherical drag (momentum)
        this.visualizerControls.fluidDragVelocity.x += deltaX * 0.005;
        this.visualizerControls.fluidDragVelocity.y -= deltaY * 0.005;
      }
      
      this.visualizerControls.lastMouseX = e.clientX;
      this.visualizerControls.lastMouseY = e.clientY;
    };
    canvas.addEventListener('mousemove', this._onCanvasMousemove);

    this._onDocumentMouseup = () => {
      this.visualizerControls.mouseDown = false;
      // Start gradual influence decay
    };
    document.addEventListener('mouseup', this._onDocumentMouseup);

    // Mouse wheel to zoom
    this._onCanvasWheel = (e) => {
      e.preventDefault();
      const delta = e.deltaY * -0.001;
      this.visualizerControls.zoom = Math.max(0.5, Math.min(2, this.visualizerControls.zoom + delta));
      this._markInteraction();
    };
    canvas.addEventListener('wheel', this._onCanvasWheel);

    // Fade out raycaster when mouse leaves canvas
    this._onCanvasMouseout = () => {
      this.visualizerControls.raycastActive = 0.0;
    };
    canvas.addEventListener('mouseout', this._onCanvasMouseout);

    // Touch controls
    this._onCanvasTouchstart = (e) => {
      if (e.touches.length === 1) {
        this.visualizerControls.mouseDown = true;
        this.visualizerControls.lastMouseX = e.touches[0].clientX;
        this.visualizerControls.lastMouseY = e.touches[0].clientY;
        
        // Update raycaster for touch
        const rect = this._cachedCanvasRect;
        this.visualizerControls.mouseVector.x = ((e.touches[0].clientX - rect.left) / rect.width) * 2 - 1;
        this.visualizerControls.mouseVector.y = -((e.touches[0].clientY - rect.top) / rect.height) * 2 + 1;
        this.visualizerControls.raycastActive = 1.0;
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        this.visualizerControls.touchStartDistance = Math.sqrt(dx * dx + dy * dy);
      }
      this._markInteraction();
    };
    canvas.addEventListener('touchstart', this._onCanvasTouchstart);

    this._onCanvasTouchmove = (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && this.visualizerControls.mouseDown) {
        // Update raycaster for touch move
        const rect = this._cachedCanvasRect;
        this.visualizerControls.mouseVector.x = ((e.touches[0].clientX - rect.left) / rect.width) * 2 - 1;
        this.visualizerControls.mouseVector.y = -((e.touches[0].clientY - rect.top) / rect.height) * 2 + 1;
        this.visualizerControls.raycastActive = 1.0;

        const deltaX = e.touches[0].clientX - this.visualizerControls.lastMouseX;
        const deltaY = e.touches[0].clientY - this.visualizerControls.lastMouseY;
        
        this.visualizerControls.rotationVelocityX += deltaY * this.visualizerControls.mouseSensitivity * this.visualizerControls.interactionBoost;
        this.visualizerControls.rotationVelocityY += deltaX * this.visualizerControls.mouseSensitivity * this.visualizerControls.interactionBoost;
        this.visualizerControls.userInfluence = 1.0;
        
        if (this.visualizerControls.fluidDragVelocity && this.visualizerControls.fluidDragVelocity.x !== undefined) {
          // Translate swipe vector to spherical drag (momentum)
          this.visualizerControls.fluidDragVelocity.x += deltaX * 0.005;
          this.visualizerControls.fluidDragVelocity.y -= deltaY * 0.005;
        }
        
        this.visualizerControls.lastMouseX = e.touches[0].clientX;
        this.visualizerControls.lastMouseY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const delta = (distance - this.visualizerControls.touchStartDistance) * 0.01;
        this.visualizerControls.zoom = Math.max(0.5, Math.min(2, this.visualizerControls.zoom + delta));
        this.visualizerControls.touchStartDistance = distance;
      }
    };
    canvas.addEventListener('touchmove', this._onCanvasTouchmove);

    this._onCanvasTouchend = () => {
      this.visualizerControls.mouseDown = false;
      this.visualizerControls.raycastActive = 0.0;
    };
    canvas.addEventListener('touchend', this._onCanvasTouchend);
    canvas.addEventListener('touchcancel', this._onCanvasTouchend);
  }

  /**
   * Start telemetry updates
   */
  startTelemetryUpdates() {
    // IMPORTANT: Visualizer must NOT write to global telemetry elements like #fps-counter.
    // The main renderer (MainApp) owns those stats; duplicate writers cause flicker/layout shifts.
    const uptimeEl = this.uptimeEl || document.getElementById('uptime');
    if (!uptimeEl) {
      return;
    }

    const updateTelemetry = () => {
      const uptime = Math.floor((Date.now() - this.sessionStartTime) / 1000);
      uptimeEl.textContent = `${Math.floor(uptime / 60)}m ${uptime % 60}s`;
    };

    updateTelemetry();
    const intervalId = setInterval(updateTelemetry, 1000);
    this._telemetryIntervals.push(intervalId);
  }

  /**
   * Pause animation
   */
  pause() {
    this._isPaused = true;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * Resume animation
   */
  resume() {
    if (this._isPaused && !this._destroyed) {
      this._isPaused = false;
      this.lastFrameTime = performance.now();
      if (this._rafId === null && this._animate) {
        this._rafId = requestAnimationFrame(this._animate);
      }
    }
  }

  /**
   * Toggle widget mode
   * @param {boolean} isWidget
   */
  setWidgetMode(isWidget) {
    this.widgetMode = isWidget;

    // Recalculate camera aspect + renderer size for the new window dimensions.
    // Deferred one frame so the DOM has settled after the Electron window transition.
    if (this._onWindowResize) {
      requestAnimationFrame(() => {
        if (!this._destroyed && this._onWindowResize) this._onWindowResize();
      });
    }
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    
    // Cancel animation frame
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    
    // Clear intervals
    this._telemetryIntervals.forEach(id => clearInterval(id));
    this._telemetryIntervals = [];
    
    // Clear timeout
    if (this._lowPowerTimer) {
      clearTimeout(this._lowPowerTimer);
      this._lowPowerTimer = null;
    }
    
    // Cleanup EventBus listeners (handsfree mode support)
    if (this._eventBusCleanup && this._eventBusCleanup.length > 0) {
      this._eventBusCleanup.forEach(cleanup => {
        try {
          cleanup();
        } catch (error) {
          this.log.error('[Visualizer] Failed to cleanup EventBus listener:', error);
        }
      });
      this._eventBusCleanup = [];
    }
    
    // Remove event listeners
    if (this._onVisualizerResize) {
      window.removeEventListener('resize', this._onVisualizerResize);
      window.removeEventListener('scroll', this._onVisualizerResize, { capture: true });
    }
    if (this._onWindowResize) window.removeEventListener('resize', this._onWindowResize);
    if (this._onVisibilityChange) document.removeEventListener('visibilitychange', this._onVisibilityChange);
    if (this._onBeforeUnload) window.removeEventListener('beforeunload', this._onBeforeUnload);
    if (this._onWindowBlur) window.removeEventListener('blur', this._onWindowBlur);
    if (this._onWindowFocus) window.removeEventListener('focus', this._onWindowFocus);
    
    // Removed legacy window.guru.off status listener
    
    // Remove canvas listeners
    const canvas = this.canvasEl || document.getElementById('scene-canvas');
    if (canvas) {
      if (this._onCanvasMousedown) canvas.removeEventListener('mousedown', this._onCanvasMousedown);
      if (this._onCanvasMousemove) canvas.removeEventListener('mousemove', this._onCanvasMousemove);
      if (this._onCanvasWheel) canvas.removeEventListener('wheel', this._onCanvasWheel);
      if (this._onCanvasMouseout) canvas.removeEventListener('mouseout', this._onCanvasMouseout);
      if (this._onCanvasTouchstart) canvas.removeEventListener('touchstart', this._onCanvasTouchstart);
      if (this._onCanvasTouchmove) canvas.removeEventListener('touchmove', this._onCanvasTouchmove);
      if (this._onCanvasTouchend) {
        canvas.removeEventListener('touchend', this._onCanvasTouchend);
        canvas.removeEventListener('touchcancel', this._onCanvasTouchend);
      }
    }
    
    if (this._onDocumentMouseup) document.removeEventListener('mouseup', this._onDocumentMouseup);
    
    // Remove overlay
    if (this._overlayEl && this._overlayEl.parentNode) {
      this._overlayEl.parentNode.removeChild(this._overlayEl);
      this._overlayEl = null;
    }
    
    // Dispose THREE.js resources
    if (this.neuralNetwork) {
      const { scene, renderer, cosmosData } = this.neuralNetwork;
      
      // Dispose cosmos bloom pipeline before scene traversal
      if (cosmosData) {
        // Bloom pipeline has been removed; no composer or bloomPass to dispose.
      }
      
      if (scene) {
        scene.traverse((object) => {
          if (object.geometry) object.geometry.dispose();
          if (object.material) {
            if (Array.isArray(object.material)) {
              object.material.forEach(material => material.dispose());
            } else {
              object.material.dispose();
            }
          }
        });
      }
      
      if (renderer) {
        renderer.dispose();
      }
      
      this.neuralNetwork = null;
    }
    
    // Explicitly release internal matrices/vectors and raycasting structures
    this._tmpVec1 = null;
    this._tmpVec2 = null;
    if (this.visualizerControls) {
      this.visualizerControls.mathSphere = null;
      this.visualizerControls.intersectTarget = null;
      this.visualizerControls.fluidDragVelocity = null;
      this.visualizerControls.fluidDragAccum = null;
      this.visualizerControls.raycastIntersection = null;
      this.visualizerControls.mouseVector = null;
      this.visualizerControls.raycaster = null;
    }
    
    this.log.debug('[Visualizer] Visualizer destroyed and cleaned up');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeuralNetworkVisualizer;
}

if (typeof window !== 'undefined') {
  window.NeuralNetworkVisualizer = NeuralNetworkVisualizer;
}
