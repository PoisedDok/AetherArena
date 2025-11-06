'use strict';

/**
 * @.architecture
 * 
 * Incoming: window.guru.state.assistant (status changes), window.guru.state.audioLevel (mic level), User interactions (mouse/touch drag, wheel zoom, window focus/blur) --- {system_state_types.assistant_status | dom_types.interaction_event, string | Event}
 * Processing: THREE.js rendering (90-150 nodes, 2.5 distance connections), continuous orbital motion with audio-reactive scaling, state-driven color mapping (8 states: offline/listening/speaking/thinking/working/waiting/error/idle), adaptive FPS-based optimization (auto-adjust pixelRatio 0.9-1.5, updateEveryN 1-4 frames, connectionUpdateEveryN 2-8 frames), low-power mode after 12s idle, frame skipping (3x hidden, 2x low-power/widget, 1x active) --- {11 jobs: JOB_INITIALIZE, JOB_RENDER_MARKDOWN, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_GET_STATE, JOB_ROUTE_BY_TYPE, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_DISPOSE}
 * Outgoing: Canvas render (60 FPS target), Telemetry DOM updates (#fps-counter, #node-count, #uptime) --- {render_output, canvas_frame}
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

class NeuralNetworkVisualizer {
  constructor() {
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
    this._onGuruStatus = null;
    this._overlayEl = null;

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
   * Initialize visualizer
   */
  init() {
    console.log('🎨 Initializing Enhanced Neural Network Visualization...');
    this.initializeThreeJS();
  }

  /**
   * Get current system state from guru
   * @returns {string}
   */
  getSystemState() {
    // Check if backend is connected
    const isConnected = window.guru && window.guru.ws && window.guru.ws.readyState === 1;
    
    if (!isConnected) {
      return 'offline';  // Backend offline - show purple
    }
    
    // Return assistant state (idle, listening, thinking, speaking, working, waiting)
    return (window.guru && window.guru.state.assistant) || 'idle';
  }

  /**
   * Initialize THREE.js scene
   */
  async initializeThreeJS() {
    const canvas = document.getElementById('scene-canvas');
    if (!canvas) {
      console.error('[Visualizer] Canvas element #scene-canvas not found');
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ 
      canvas: canvas, 
      alpha: true, 
      antialias: true, 
      powerPreference: 'low-power', 
      preserveDrawingBuffer: false 
    });

    try { 
      canvas.style.willChange = 'transform'; 
    } catch (_) {}

    // Initialize temp vectors after THREE is guaranteed
    try { 
      this._tmpVec1 = new THREE.Vector3(); 
      this._tmpVec2 = new THREE.Vector3(); 
    } catch (_) {}

    try {
      // Cap pixel ratio for performance on high-DPI displays
      const maxDevicePixelRatio = 1.5;
      const ratio = Math.min(window.devicePixelRatio || 1, maxDevicePixelRatio);
      renderer.setPixelRatio(ratio);
      this._maxPixelRatio = ratio;
      this._currentPixelRatio = ratio;
    } catch (_) {}
    
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    
    const nodes = [];
    const connections = [];

    // --- CONFIG: Geometry ---
    // Reduce node count on low-end devices to save CPU/GPU
    const isLowEnd = (() => {
      try { 
        return navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4; 
      } catch(_) { 
        return false; 
      }
    })();
    const nodeCount = isLowEnd ? 90 : 150;
    const SPHERE_RADIUS = 3.5;
    const BOUNDARY_RADIUS = 6;
    
    const nodeCountEl = document.getElementById('node-count');
    if (nodeCountEl) {
      nodeCountEl.innerText = nodeCount;
    }
    
    // Create nodes
    for (let i = 0; i < nodeCount; i++) {
      const geometry = new THREE.SphereGeometry(0.03, 12, 12);
      const material = new THREE.MeshBasicMaterial({ 
        color: 0x00d4ff, 
        transparent: true, 
        opacity: 0.8 
      });
      const node = new THREE.Mesh(geometry, material);
      
      const radius = SPHERE_RADIUS * Math.cbrt(Math.random());
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
    
    // Create connections
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const distance = nodes[i].position.distanceTo(nodes[j].position);
        if (distance < 2.5 && Math.random() > 0.7) {
          const geometry = new THREE.BufferGeometry().setFromPoints([
            nodes[i].position, 
            nodes[j].position
          ]);
          const material = new THREE.LineBasicMaterial({ 
            color: 0x00d4ff, 
            transparent: true, 
            opacity: 0.3 
          });
          const connection = new THREE.Line(geometry, material);
          scene.add(connection);
          connections.push({ line: connection, node1: nodes[i], node2: nodes[j] });
        }
      }
    }
    
    camera.position.z = 8;
    
    this.setupVisualizerControls(canvas, camera, scene);

    // Helpers for low-power switching
    const setPixelRatio = (r) => { 
      try { 
        renderer.setPixelRatio(r); 
      } catch(_) {} 
      this._currentPixelRatio = r; 
    };

    this._enterLowPower = () => {
      this._lowPowerMode = true;
      try { 
        setPixelRatio(Math.max(0.9, (this._currentPixelRatio || 1) - 0.1)); 
      } catch(_) {}
      this._updateEveryN = Math.max(this._updateEveryN, 4);
      this._connectionUpdateEveryN = Math.max(this._connectionUpdateEveryN, 8);
    };

    this._exitLowPower = () => {
      this._lowPowerMode = false;
      try { 
        setPixelRatio(this._maxPixelRatio); 
      } catch(_) {}
      // allow adaptive logic to bring N back down naturally
    };

    this._markInteraction = () => {
      this._exitLowPower();
      if (this._lowPowerTimer) { 
        try { 
          clearTimeout(this._lowPowerTimer); 
        } catch(_) {} 
      }
      this._lowPowerTimer = setTimeout(() => this._enterLowPower(), this._lowPowerIdleMs);
    };
    
    // Enhanced control system for JARVIS-like interaction
    this.visualizerControls = {
      // Base rotation that never stops completely
      baseRotationX: 0.001,
      baseRotationY: 0.002,
      
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
      
      // Zoom and interaction
      zoom: 1,
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
      const desiredSkip = (document.hidden ? 3 : ((this._lowPowerMode || this.widgetMode) ? 2 : 1));
      this._frameSkipCounter = (this._frameSkipCounter + 1) % desiredSkip;
      if (this._frameSkipCounter !== 0) {
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
        } catch (_) {}
      } else if (avgFps < 40) {
        this._updateEveryN = 2;
        this._connectionUpdateEveryN = 4;
        try {
          this._currentPixelRatio = Math.max(1.0, (this._currentPixelRatio || 1) - 0.02);
          renderer.setPixelRatio(this._currentPixelRatio);
        } catch (_) {}
      } else if (avgFps > 55) {
        this._updateEveryN = 1;
        this._connectionUpdateEveryN = 2;
        try {
          this._currentPixelRatio = Math.min(this._maxPixelRatio, (this._currentPixelRatio || 1) + 0.02);
          renderer.setPixelRatio(this._currentPixelRatio);
        } catch (_) {}
      }
      
      let audioLevel = ((window.guru && window.guru.state.audioLevel) || 0.05) * 2.1;
      audioLevel = Math.min(audioLevel, 1.0);
      const systemState = this.getSystemState();
      const isListening = systemState === 'listening';
      
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
      
      // Enhanced audio-reactive scaling
      const audioBoost = isListening ? 1.5 : 1.0;
      const baseScale = 1 + (audioLevel * audioBoost * 0.3);
      scene.scale.setScalar(baseScale * this.visualizerControls.zoom);

      const nodeColor = this.getColorForSystemState(systemState);
      // If a status event arrived, immediately refresh colors even in low-power
      if (this._pendingStateChange) {
        try {
          nodes.forEach((node) => {
            node.material.color.copy(nodeColor);
          });
          connections.forEach((conn) => {
            conn.line.material.color.copy(nodeColor);
          });
        } catch (_) {}
        this._pendingStateChange = false;
      }
      
      // Enhanced node animation with continuous movement (skip heavy math in low-power)
      const updateNodes = !this._lowPowerMode && (this._frameCount % this._updateEveryN) === 0;
      if (updateNodes) nodes.forEach((node, index) => {
        let velocityMultiplier = 1.0;
        const timeOffset = index * 0.1;
        const globalTime = Date.now() * 0.001;
        
        if (!isListening) {
          // Gentle continuous movement when idle
          velocityMultiplier = 0.12;
          if (this._tmpVec1) {
            this._tmpVec1.subVectors(node.originalPosition, node.position).multiplyScalar(0.003);
            node.velocity.add(this._tmpVec1);
          } else {
            const returnForce = new THREE.Vector3().subVectors(node.originalPosition, node.position);
            node.velocity.add(returnForce.multiplyScalar(0.003));
          }
          node.velocity.multiplyScalar(0.96);
          
          // Add subtle orbital motion
          if (this._tmpVec1) {
            this._tmpVec1.set(
              Math.sin(globalTime * 0.5 + timeOffset) * 0.002,
              Math.cos(globalTime * 0.3 + timeOffset) * 0.002,
              Math.sin(globalTime * 0.4 + timeOffset) * 0.001
            );
            node.velocity.add(this._tmpVec1);
          } else {
            const orbitalForce = new THREE.Vector3(
              Math.sin(globalTime * 0.5 + timeOffset) * 0.002,
              Math.cos(globalTime * 0.3 + timeOffset) * 0.002,
              Math.sin(globalTime * 0.4 + timeOffset) * 0.001
            );
            node.velocity.add(orbitalForce);
          }
        } else {
          // Enhanced movement during listening
          const audioReactivity = 1.0 + (audioLevel * 0.5);
          velocityMultiplier = audioReactivity;
          
          // Pulsing motion synchronized with audio
          const pulse = Math.sin(globalTime * 2 + timeOffset) * audioLevel * 0.1;
          if (this._tmpVec2) {
            this._tmpVec2.copy(node.originalPosition).normalize().multiplyScalar(pulse);
            node.velocity.add(this._tmpVec2);
          } else {
            const pulseDirection = node.originalPosition.clone().normalize().multiplyScalar(pulse);
            node.velocity.add(pulseDirection);
          }
        }
        
        if (node.position.addScaledVector) {
          node.position.addScaledVector(node.velocity, velocityMultiplier);
        } else {
          node.position.add(node.velocity.clone().multiplyScalar(velocityMultiplier));
        }

        // Dynamic contraction effect for listening state
        if (isListening) {
          const timeFactor = Math.sin(globalTime * 1.5 + timeOffset);
          const audioFactor = 0.7 + audioLevel * 4.0;
          let contraction = 0.6 + (timeFactor * 0.15 * audioFactor);
          if (this._tmpVec1) {
            this._tmpVec1.copy(node.originalPosition).multiplyScalar(contraction);
            node.position.lerp(this._tmpVec1, 0.08 + (audioLevel * 0.2));
          } else {
            node.position.lerp(node.originalPosition.clone().multiplyScalar(contraction), 0.08 + (audioLevel * 0.2));
          }
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
        node.material.color.lerp(nodeColor, 0.08);
        
        // Enhanced scaling with breathing effect
        const breathingEffect = Math.sin(globalTime + timeOffset * 2) * 0.2;
        const audioScale = audioLevel * (isListening ? 0.4 : 0.1);
        const finalScale = 1 + breathingEffect + audioScale;
        node.scale.setScalar(Math.max(0.5, finalScale));
        
        // Dynamic opacity
        node.material.opacity = 0.6 + audioLevel * 0.3 + Math.sin(globalTime * 0.5 + timeOffset) * 0.1;
      });
      
      // Enhanced connection updates (skip in low-power)
      const updateConnections = !this._lowPowerMode && (this._frameCount % this._connectionUpdateEveryN) === 0;
      if (updateConnections) connections.forEach((conn) => {
        const positions = conn.line.geometry.attributes.position.array;
        positions.set([conn.node1.position.x, conn.node1.position.y, conn.node1.position.z], 0);
        positions.set([conn.node2.position.x, conn.node2.position.y, conn.node2.position.z], 3);
        conn.line.geometry.attributes.position.needsUpdate = true;
        
        // Dynamic connection opacity with pulsing
        const distance = conn.node1.position.distanceTo(conn.node2.position);
        const proximityFactor = Math.max(0, 1 - distance / 5);
        const pulse = Math.sin(Date.now() * 0.001) * 0.1;
        
        conn.line.material.opacity = (0.2 + audioLevel * 0.3 + pulse) * proximityFactor;
        conn.line.material.color.lerp(conn.node1.material.color, 0.1);
      });
      
      renderer.render(scene, camera);
      this._rafId = requestAnimationFrame(animate);
    };

    // Store the loop so we can reliably resume after pause/minimize
    this._animate = animate;
    this._rafId = requestAnimationFrame(this._animate);
    
    // Resize handler
    this._onWindowResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
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
        } catch(_) {}
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange, { passive: true });

    // Listen for backend status changes so color updates reflect immediately
    if (window.guru && typeof window.guru.on === 'function') {
      this._onGuruStatus = (status) => {
        this._pendingStateChange = true;
        // Ensure a frame is rendered soon even if low-power and idle
        if (!this._rafId) {
          try { 
            this._rafId = requestAnimationFrame(this._animate || (() => {})); 
          } catch (_) {}
        }
      };
      try { 
        window.guru.on('status', this._onGuruStatus); 
      } catch (_) {}
    }

    // Defensive teardown on unload
    this._onBeforeUnload = () => {
      try { 
        this.destroy(); 
      } catch(_) {}
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
        } catch(_) {}
      }
    };
    window.addEventListener('blur', this._onWindowBlur, { passive: true });
    window.addEventListener('focus', this._onWindowFocus, { passive: true });
    
    this.neuralNetwork = { scene, camera, renderer, nodes, connections };
    console.log('✅ Enhanced Neural Network Visualization initialized');
  }

  /**
   * Get rotation multiplier based on system state
   * @param {string} systemState
   * @param {number} audioLevel
   * @returns {number}
   */
  getStateRotationMultiplier(systemState, audioLevel) {
    const baseMultiplier = {
      'offline': 0.5,  // Slow rotation when offline
      'listening': 2.0 + audioLevel * 3.0,
      'speaking': 1.5 + audioLevel * 2.0,
      'thinking': 1.8,
      'working': 2.2,
      'waiting': 1.3,
      'error': 0.7,
      'idle': 1.0
    };
    
    return baseMultiplier[systemState] || 1.0;
  }

  /**
   * Get color for system state
   * @param {string} systemState
   * @returns {THREE.Color}
   */
  getColorForSystemState(systemState) {
    switch(systemState) {
      case 'offline': return new THREE.Color(0.6, 0.3, 0.9); // Purple - backend offline
      case 'listening': return new THREE.Color(0, 0.83, 1); // Blue - listening to user
      case 'speaking': return new THREE.Color(1, 0.58, 0); // Orange - speaking/outputting
      case 'thinking': return new THREE.Color(0.13, 0.86, 0.9); // Cyan/Blueish - processing/thinking
      case 'working': return new THREE.Color(0.13, 0.86, 0.9); // Cyan/Blueish - processing/working
      case 'waiting': return new THREE.Color(0.98, 0.8, 0.08); // Yellow - waiting
      case 'error': return new THREE.Color(1, 0.2, 0.2); // Red - error
      case 'idle':
      default: return new THREE.Color(1, 1, 1); // White - idle (online)
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

    // Mouse drag to rotate
    this._onCanvasMousedown = (e) => {
      this.visualizerControls.mouseDown = true;
      this.visualizerControls.lastMouseX = e.clientX;
      this.visualizerControls.lastMouseY = e.clientY;
      this._markInteraction();
    };
    canvas.addEventListener('mousedown', this._onCanvasMousedown);

    this._onCanvasMousemove = (e) => {
      if (!this.visualizerControls.mouseDown) return;
      
      const deltaX = e.clientX - this.visualizerControls.lastMouseX;
      const deltaY = e.clientY - this.visualizerControls.lastMouseY;
      
      // Enhanced velocity calculation with interaction boost
      this.visualizerControls.rotationVelocityX += deltaY * this.visualizerControls.mouseSensitivity * this.visualizerControls.interactionBoost;
      this.visualizerControls.rotationVelocityY += deltaX * this.visualizerControls.mouseSensitivity * this.visualizerControls.interactionBoost;
      
      // Full influence during active dragging
      this.visualizerControls.userInfluence = 1.0;
      
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

    // Touch controls
    this._onCanvasTouchstart = (e) => {
      if (e.touches.length === 1) {
        this.visualizerControls.mouseDown = true;
        this.visualizerControls.lastMouseX = e.touches[0].clientX;
        this.visualizerControls.lastMouseY = e.touches[0].clientY;
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
        const deltaX = e.touches[0].clientX - this.visualizerControls.lastMouseX;
        const deltaY = e.touches[0].clientY - this.visualizerControls.lastMouseY;
        
        this.visualizerControls.rotationVelocityX += deltaY * this.visualizerControls.mouseSensitivity * this.visualizerControls.interactionBoost;
        this.visualizerControls.rotationVelocityY += deltaX * this.visualizerControls.mouseSensitivity * this.visualizerControls.interactionBoost;
        this.visualizerControls.userInfluence = 1.0;
        
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

    const onTouchEnd = () => {
      this.visualizerControls.mouseDown = false;
    };
    canvas.addEventListener('touchend', onTouchEnd);
    canvas.addEventListener('touchcancel', onTouchEnd);
  }

  /**
   * Start telemetry updates
   */
  startTelemetryUpdates() {
    const updateTelemetry = () => {
      const avgFps = this.fpsValues.length 
        ? Math.round(this.fpsValues.reduce((a, b) => a + b, 0) / this.fpsValues.length)
        : 0;
      
      const fpsEl = document.getElementById('fps-counter');
      if (fpsEl) {
        fpsEl.textContent = `${avgFps} FPS`;
      }
      
      const uptimeEl = document.getElementById('uptime');
      if (uptimeEl) {
        const uptime = Math.floor((Date.now() - this.sessionStartTime) / 1000);
        uptimeEl.textContent = `${Math.floor(uptime / 60)}m ${uptime % 60}s`;
      }
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
  }

  /**
   * Resume animation
   */
  resume() {
    if (this._isPaused && !this._destroyed) {
      this._isPaused = false;
      if (!this._rafId && this._animate) {
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
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
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
    
    // Remove event listeners
    if (this._onWindowResize) window.removeEventListener('resize', this._onWindowResize);
    if (this._onVisibilityChange) document.removeEventListener('visibilitychange', this._onVisibilityChange);
    if (this._onBeforeUnload) window.removeEventListener('beforeunload', this._onBeforeUnload);
    if (this._onWindowBlur) window.removeEventListener('blur', this._onWindowBlur);
    if (this._onWindowFocus) window.removeEventListener('focus', this._onWindowFocus);
    
    if (this._onGuruStatus && window.guru && typeof window.guru.off === 'function') {
      try {
        window.guru.off('status', this._onGuruStatus);
      } catch (_) {}
    }
    
    // Remove canvas listeners
    const canvas = document.getElementById('scene-canvas');
    if (canvas) {
      if (this._onCanvasMousedown) canvas.removeEventListener('mousedown', this._onCanvasMousedown);
      if (this._onCanvasMousemove) canvas.removeEventListener('mousemove', this._onCanvasMousemove);
      if (this._onCanvasWheel) canvas.removeEventListener('wheel', this._onCanvasWheel);
      if (this._onCanvasTouchstart) canvas.removeEventListener('touchstart', this._onCanvasTouchstart);
      if (this._onCanvasTouchmove) canvas.removeEventListener('touchmove', this._onCanvasTouchmove);
    }
    
    if (this._onDocumentMouseup) document.removeEventListener('mouseup', this._onDocumentMouseup);
    
    // Remove overlay
    if (this._overlayEl && this._overlayEl.parentNode) {
      this._overlayEl.parentNode.removeChild(this._overlayEl);
      this._overlayEl = null;
    }
    
    // Dispose THREE.js resources
    if (this.neuralNetwork) {
      const { scene, renderer } = this.neuralNetwork;
      
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
    
    console.log('✅ Visualizer destroyed and cleaned up');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeuralNetworkVisualizer;
}

if (typeof window !== 'undefined') {
  window.NeuralNetworkVisualizer = NeuralNetworkVisualizer;
  console.log('📦 NeuralNetworkVisualizer loaded');
}

