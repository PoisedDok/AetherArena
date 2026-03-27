'use strict';

/**
 * @.architecture
 *
 * Incoming: Shader uniforms from Visualizer.js cosmos update loop --- {float, float[9], vec3}
 * Processing: GPU-side vertex displacement (simplex noise + SH topology + audio pulse + breathing),
 *   finite-difference displaced normals (2 extra noise samples per vertex),
 *   fragment dual-layer iridescence (opal-like depth) + PBR-lite lighting + Fresnel rim +
 *   subsurface scattering + analytical environment reflection + ACES tone mapping,
 *   multi-band FFT reactivity (bass→noise, lowMid→flow, highMid→specular, treble→shimmer),
 *   atmosphere soft circles with audio jitter + state-driven radial push/pull
 *   --- {2 jobs: JOB_ORB_RENDER, JOB_ATMOSPHERE_RENDER}
 * Outgoing: gl_FragColor per fragment per frame (ACES tone-mapped) --- {rgba, render_output}
 *
 * @module renderer/main/modules/visualizer/cosmos-shaders
 *
 * GLSL shaders and state constants for cosmos orb visualization.
 * Separated from Visualizer.js to keep the main class manageable.
 * No runtime logic — only string constants and a parameter table.
 */

// ============================================================================
// 3D Simplex Noise (Ashima / Stefan Gustavson)
// Compact GLSL implementation, output range ~[-1, 1]
// ============================================================================

const SIMPLEX_NOISE_GLSL = /* glsl */ `
vec4 _sn_permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 _sn_taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod(i, 289.0);
  vec4 p = _sn_permute(_sn_permute(_sn_permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = _sn_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

vec4 snoise_grad(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod(i, 289.0);
  vec4 p = _sn_permute(_sn_permute(_sn_permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = _sn_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m3 = m2 * m;
  vec4 m4 = m2 * m2;
  
  float n = dot(m4, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  
  vec3 grad =
      -8.0 * m3.x * dot(p0, x0) * x0 + m4.x * p0 +
      -8.0 * m3.y * dot(p1, x1) * x1 + m4.y * p1 +
      -8.0 * m3.z * dot(p2, x2) * x2 + m4.z * p2 +
      -8.0 * m3.w * dot(p3, x3) * x3 + m4.w * p3;

  return vec4(42.0 * n, 42.0 * grad);
}
`;

// ============================================================================
// Orb Vertex Shader
// Displaces IcosahedronGeometry vertices along normals using multi-octave
// simplex noise. Audio pulses and breathing are additive.
// ============================================================================

const ORB_VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uNoiseAmp;
uniform float uNoiseSpeed;
uniform float uBreathScale;
uniform float uRadiusScale;
uniform float uAudioLevel;
uniform float uAudioSens;
uniform float uBass;
uniform float uAudioPulse;  // Smoothed speech envelope (fast-attack / slow-release)
uniform float uSH[9];  // Spherical Harmonic coefficients (bands 0-2) for topology
uniform vec3 uMousePos;
uniform float uMouseActive;
uniform vec3 uFluidDrag;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying float vDisplacement;
varying float vFresnel;

${SIMPLEX_NOISE_GLSL}

// Full displacement at an arbitrary surface point (noise + audio pulse).
// Factored out so finite-difference normal sampling reuses exact same math.
//
// OCEAN PLANET architecture — directional traveling waves + organic noise:
//
//   SPATIAL FREQUENCY CALIBRATION (radius 1.8 sphere):
//     For N visible wave crests per hemisphere, need freq ≈ N * pi / 1.8.
//       3 crests → freq ≈ 5.2    4 crests → freq ≈ 7.0    5 crests → freq ≈ 8.7
//     Previous values (0.28-0.35) created 0.1 wavelengths across the sphere —
//     each wave was 10x BIGGER than the sphere, so displacement was invisible
//     uniform scaling ("balloon"). Now calibrated to sphere geometry.
//
//   swell1/swell2: Two dominant crossing wave trains (freq 4.0 / 3.2).
//     ~3-4 visible crests per hemisphere. Where they cross: constructive
//     peaks and destructive flat zones — natural non-uniformity.
//   wind:    Multi-feature simplex noise (scale 2.5) — organic texture.
//   chop:    High-freq directional ripple (freq 7.0) — fine surface detail.
//   storm:   Regional intensity modulator (scale 0.6) — calm vs. active zones.
//
//   Amplitudes: REDUCED proportional to frequency increase. Visual interest
//   comes from MANY small waves creating bumpy silhouette + crest/trough
//   lighting contrast, not one giant invisible wave.
//
//   Temporal: Calibrated so swells traverse one wavelength in 8-12s (majestic),
//   chop in 3-4s (shimmer). noiseSpeed 0.34 (offline) → visible motion.
//
// Bass energy boosts the swell layers (visible low-freq shape change).
// Audio pulse modulates swell amplitudes — waves physically grow during speech.
float computeDisplacement(vec3 p, vec3 basePos, float nt) {
  float bassBoost = 1.0 + uBass * 0.8;

  // Speech rhythm: swells grow 0-60% with audio envelope.
  // At silence (uAudioPulse=0): audioPulse=1.0 → swells at base amplitude.
  // At peak speech (uAudioPulse=1.0): audioPulse=1.6 → 60% swell boost.
  // This makes waves visibly surge on syllable onsets and recede during pauses.
  float audioPulse = 1.0 + uAudioPulse * 0.6;

  // --- PRIMARY SWELL: broad rolling waves (the "heavy in and out") ---
  // Spatial freq 4.0 → ~3 crests per hemisphere. Amplitude 0.9 = dominant layer.
  // Temporal factor 1.8: at noiseSpeed 0.34, one wave crosses in ~10s (majestic).
  // Audio pulse modulates amplitude: waves surge with speech rhythm.
  float swell1 = sin(dot(p, vec3(0.75, 0.20, 0.55)) * 4.0 + nt * 1.8) * 0.9 * audioPulse;

  // --- SECONDARY SWELL: crossing direction for interference patterns ---
  // Freq 3.2, different direction → where swells cross: constructive peaks
  // and destructive calm zones. Natural ocean non-uniformity.
  float swell2 = sin(dot(p, vec3(-0.30, 0.70, 0.55)) * 3.2 + nt * 1.4) * 0.7 * audioPulse;

  // --- WIND WAVES: organic noise texture over the sine regularity ---
  // Scale 2.5: ~4 noise features visible across the sphere (was 0.45 = one blob).
  float wind = snoise(p * 2.5 + nt * 2.0) * 0.35;

  // --- CROSS CHOP: high-freq directional ripple detail ---
  // Freq 7.0 → ~5 ripple crests per hemisphere. Fast shimmer (nt * 4.5).
  float chop = sin(dot(p, vec3(0.40, -0.50, 0.72)) * 7.0 + nt * 4.5) * 0.18;

  // --- STORM MODULATION: regional intensity variation ---
  // Scale 0.6: 1-2 calm/active zones per hemisphere (was 0.12 = one uniform zone).
  // Evolves slowly so the pattern drifts organically.
  float storm = snoise(p * 0.6 + nt * 0.15) * 0.5 + 0.5;   // 0..1
  storm = mix(0.5, 1.0, storm);                               // floor at 0.5

  // Combine: swells always active (backbone), wind+chop modulated by storm.
  float raw = (swell1 + swell2) * bassBoost + (wind + chop) * storm;

  // Crest sharpening: pow(abs, 0.85) makes peaks sharper and troughs broader.
  // More aggressive than before (0.88) since waves are now individually visible.
  float d = sign(raw) * pow(abs(raw), 0.85);
  d *= uNoiseAmp;

  // Safety clamp: ±0.55 world units. With new smaller per-wave amplitudes,
  // max constructive interference (all waves aligned, noiseAmp 0.25) ≈ 0.49.
  // With audioPulse at 1.6x: max ≈ 0.54 — approaches clamp at extreme peaks.
  // At radius 1.8: max inward = 31% of radius — dramatic but no mesh inversion.
  d = clamp(d, -0.55, 0.55);

  // --- Cursor Repulsion & Ripple Wake ---
  if (uMouseActive > 0.0) {
    // Distance from this vertex to the mouse intersection point
    float mouseDist = distance(basePos, uMousePos);
    
    // Repulsion: smooth inward push (radius 0.6)
    float repulsion = smoothstep(0.6, 0.0, mouseDist);
    // Kinetic Ripple: exponential decay radiating outward
    float ripple = sin((mouseDist * 12.0) - (uTime * 15.0)) * exp(-mouseDist * 4.0) * 0.25;
    
    // Combine and apply intensity based on mouse activity
    float interactionEffect = (-repulsion * 0.35 + ripple) * uMouseActive;
    d += interactionEffect;
  }

  // Audio pulse: directional throb along Y axis (increased from 0.15 for
  // more visible rhythmic displacement during speech).
  d += sin(uTime * 6.0 + p.y * 3.0) * uAudioLevel * uAudioSens * 0.25;
  return d;
}

// Computes the analytical gradient of the displacement function with respect to the input position p.
// This calculates the exact partial derivatives instead of using finite differences,
// saving two expensive evaluations of snoise() per vertex.
vec3 computeDisplacementGradient(vec3 p, vec3 basePos, float nt) {
  float bassBoost = 1.0 + uBass * 0.8;
  float audioPulse = 1.0 + uAudioPulse * 0.6;
  
  vec3 k1 = vec3(0.75, 0.20, 0.55);
  float dot1 = dot(p, k1) * 4.0 + nt * 1.8;
  float swell1 = sin(dot1) * 0.9 * audioPulse;
  vec3 gradSwell1 = cos(dot1) * 4.0 * 0.9 * audioPulse * k1;
  
  vec3 k2 = vec3(-0.30, 0.70, 0.55);
  float dot2 = dot(p, k2) * 3.2 + nt * 1.4;
  float swell2 = sin(dot2) * 0.7 * audioPulse;
  vec3 gradSwell2 = cos(dot2) * 3.2 * 0.7 * audioPulse * k2;
  
  vec3 kChop = vec3(0.40, -0.50, 0.72);
  float dotChop = dot(p, kChop) * 7.0 + nt * 4.5;
  float chop = sin(dotChop) * 0.18;
  vec3 gradChop = cos(dotChop) * 7.0 * 0.18 * kChop;
  
  // --- Analytical Simplex Noise Gradients ---
  // Using exact analytical gradients instead of finite differences
  // Massive FPS boost by eliminating 6 extra noise evaluations per vertex
  
  float nt2 = nt * 2.0;
  float nt015 = nt * 0.15;
  
  // Wind noise analytical gradient
  vec4 windNoise = snoise_grad(p * 2.5 + nt2);
  float wind = windNoise.x * 0.35;
  vec3 gradWind = windNoise.yzw * (2.5 * 0.35); // Chain rule for scale
  
  // Storm noise analytical gradient
  vec4 stormNoise = snoise_grad(p * 0.6 + nt015);
  float s0 = stormNoise.x * 0.5 + 0.5;
  float storm = mix(0.5, 1.0, s0);
  // Corrected amplitude derivative: mix(0.5, 1.0, s0) -> 0.5 + 0.5 * (noise * 0.5 + 0.5) -> 0.25 multiplier on noise derivative
  vec3 gradStorm = stormNoise.yzw * (0.6 * 0.25);
  
  // Chain rule: d(f*g) = f*dg + g*df
  float raw = (swell1 + swell2) * bassBoost + (wind + chop) * storm;
  vec3 gradRaw = (gradSwell1 + gradSwell2) * bassBoost + (gradWind + gradChop) * storm + (wind + chop) * gradStorm;
  
  // Derivative of sign(raw) * pow(abs(raw), 0.85) is 0.85 * pow(abs(raw), -0.15) * gradRaw
  // Increased epsilon smoothly ramps the derivative over zero-crossings, eliminating sharp "edges" on waves
  float rawAbs = abs(raw) + 0.04;
  vec3 gradD = 0.85 * pow(rawAbs, -0.15) * gradRaw * uNoiseAmp;
  
  // Add gradient of the audio pulse
  vec3 gradAudio = vec3(0.0, cos(uTime * 6.0 + p.y * 3.0) * 3.0 * uAudioLevel * uAudioSens * 0.25, 0.0);

  // Add gradient of the mouse interaction
  vec3 gradMouse = vec3(0.0);
  if (uMouseActive > 0.0) {
    vec3 dir = basePos - uMousePos;
    float dist = length(dir);
    if (dist > 0.0001 && dist < 1.2) { // Only calculate if inside effect radius
      dir = dir / dist; // Normalize
      
      // Derivative of smoothstep(0.6, 0.0, dist)
      float tRep = clamp((dist - 0.6) / (-0.6), 0.0, 1.0);
      float dRepDist = dist < 0.6 ? (6.0 * tRep * (1.0 - tRep)) / (-0.6) : 0.0;
      vec3 gradRep = dir * dRepDist;
      
      // Derivative of ripple = sin(dist * 12.0 - time) * exp(-dist * 4.0) * 0.25
      float ripPhase = dist * 12.0 - uTime * 15.0;
      float ripEnv = exp(-dist * 4.0);
      float dRipEnv = -4.0 * ripEnv;
      float dRipDist = (cos(ripPhase) * 12.0 * ripEnv + sin(ripPhase) * dRipEnv) * 0.25;
      vec3 gradRip = dir * dRipDist;
      
      gradMouse = (-gradRep * 0.35 + gradRip) * uMouseActive;
    }
  }

  // If d is clamped, the gradient is 0
  float d = sign(raw) * pow(rawAbs, 0.85) * uNoiseAmp;
  if(d <= -0.55 || d >= 0.55) {
      gradD = vec3(0.0);
  }
  
  return gradD + gradAudio + gradMouse;
}

void main() {
  vec3 pos = position * uBreathScale * uRadiusScale;
  vec3 norm = normalize(normal);

  // --- Spherical Harmonics topology displacement (bands 0-2) ---
  // Lerped per-state SH coefficients create smooth shape transitions:
  // sphere (idle) → compressed (listening) → elongated (speaking) → blob (thinking)
  float sh = uSH[0]
    + uSH[1] * norm.y + uSH[2] * norm.z + uSH[3] * norm.x
    + uSH[4] * norm.x * norm.y + uSH[5] * norm.y * norm.z
    + uSH[6] * (3.0 * norm.z * norm.z - 1.0)
    + uSH[7] * norm.x * norm.z + uSH[8] * (norm.x * norm.x - norm.y * norm.y);
  pos += norm * sh * 0.3;

  float nt = uTime * uNoiseSpeed;

  // Fluid Drag: offset the position evaluated for noise to create a flowing liquid effect
  vec3 evalPos = pos + uFluidDrag;

  // Displace center vertex along normal (noise sampled at SH-displaced position)
  float displacement = computeDisplacement(evalPos, pos, nt);
  vec3 displaced = pos + norm * displacement;

  // --- Displaced normal via analytical gradients ---
  // Calculate exact partial derivatives using chain rule to avoid expensive
  // full evaluation of the displacement function multiple times.
  vec3 grad = computeDisplacementGradient(evalPos, pos, nt);
  
  // Compute normal. Because displacement is D(p) * N(p), where N is the original normal,
  // we must project the 3D gradient onto the sphere's tangent plane before perturbing.
  // This prevents the normal from incorrectly tilting inward/outward along the radial axis.
  vec3 gradSurf = grad - dot(grad, norm) * norm;
  vec3 displacedNormal = normalize(norm - gradSurf);

  // Outputs for fragment shader
  vNormal = normalize(normalMatrix * displacedNormal);
  vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
  vWorldPosition = worldPos.xyz;
  vDisplacement = displacement;

  // Pre-compute Fresnel (view-dependent edge glow)
  vec3 worldViewDir = normalize(cameraPosition - worldPos.xyz);
  vFresnel = 1.0 - max(dot(worldViewDir, vNormal), 0.0);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

// ============================================================================
// Orb Fragment Shader
// PBR-lite lighting: ambient + diffuse + specular + dual-layer iridescent flow +
// Fresnel rim + subsurface scattering + analytical environment reflection.
// ACES filmic tone mapping before output for graceful HDR compression.
// Key light from upper-right creates highlight/shadow for true 3D depth.
// ============================================================================

const ORB_FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uFresnelPower;
uniform float uFlowSpeed;
uniform float uEmissiveIntensity;
uniform float uAudioLevel;
uniform float uAudioSens;
uniform float uSSSIntensity;   // Subsurface scattering strength (per-state)
uniform float uEnvReflect;     // Environment reflection strength (per-state)
uniform float uBass;           // FFT: low-frequency energy
uniform float uLowMid;         // FFT: low-mid energy (drives flow speed)
uniform float uHighMid;        // FFT: high-mid energy (drives specular/emissive)
uniform float uTreble;         // FFT: high-frequency energy (drives shimmer)
uniform float uAudioPulse;    // Smoothed speech envelope (drives rhythmic lighting)
uniform float uAlphaBoost;    // 0.0 = normal translucency, 1.0 = widget near-opaque
uniform vec3 uMousePos;       // Mouse interaction point in world space
uniform float uMouseActive;   // Mouse active state (0.0 to 1.0)

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying float vDisplacement;
varying float vFresnel;

// ACES filmic tone mapping (Narkowicz approximation).
// Maps HDR values [0, inf) to LDR [0, 1] with graceful highlight compression.
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  // --- Fresnel rim (0 at center, 1 at silhouette edges) ---
  float fresnel = pow(vFresnel, uFresnelPower);

  // --- Dual-layer iridescent flow (opal-like depth) ---
  // Low-mid energy accelerates flow animation for responsive feel.
  //
  // ANTI-ALIASING NOTE: The iterative feedback loop accumulates large values
  // (d1/a1 grow to ~5-10). These MUST NOT multiply UV coordinates in the
  // output (cos(uv * d1) creates uncontrolled spatial frequency → moiré
  // vertical stripes). Instead, UV is added as a bounded phase offset.
  // The accumulator provides time-varying flow; UV provides spatial variation.
  float flow = uTime * uFlowSpeed * (1.0 + uLowMid * 0.4);

  // Layer 1: slow, large-scale (deep layer — visible through the surface)
  float d1 = -flow * 0.6;
  float a1 = 0.0;
  vec2 uv1 = vWorldPosition.xz * 0.18 + vWorldPosition.xy * 0.07;
  for (float i = 0.0; i < 4.0; i += 1.0) {
    a1 += cos(i - d1 - a1 * uv1.x * 0.6);
    d1 += sin(uv1.y * i + a1);
  }
  vec3 deepFlow = vec3(
    cos(d1 + uv1.x * 2.0) * 0.5 + 0.5,
    cos(a1 + uv1.y * 2.0) * 0.5 + 0.5,
    cos(a1 + d1) * 0.5 + 0.5
  );

  // Layer 2: faster, finer (surface layer — catches light and shifts)
  float d2 = -flow * 1.4;
  float a2 = 0.0;
  vec2 uv2 = vWorldPosition.yz * 0.30 + vWorldPosition.xz * 0.18;
  for (float i = 0.0; i < 3.0; i += 1.0) {
    a2 += cos(i - d2 - a2 * uv2.x * 0.6);
    d2 += sin(uv2.y * i + a2);
  }
  vec3 surfaceFlow = vec3(
    cos(d2 + uv2.x * 2.5) * 0.5 + 0.5,
    cos(a2 + uv2.y * 2.5) * 0.5 + 0.5,
    cos(a2 + d2) * 0.5 + 0.5
  );

  // Blend: Fresnel-weighted — deep layer shows at edges, surface at center
  vec3 flowColor = mix(deepFlow, surfaceFlow, 0.45 + fresnel * 0.3);

  // --- Spectral Thin-Film Iridescence ---
  // Calculates a phase shift based on viewing angle and flow to simulate
  // thin-film interference (like soap bubbles or oil slicks).
  float viewAngle = 1.0 - vFresnel; // dot(V, N)
  float filmThickness = flowColor.r * 0.5 + 0.5; // Flow defines local "thickness" of the film
  
  // Reduced phase multiplier to avoid tight "Newton's rings" and create a broad, premium sheen
  float phase = (viewAngle * 0.4 + filmThickness * 0.6) * 2.5; 
  
  // Generate spectral colors using cosine palettes
  vec3 spectralColor = vec3(
    0.5 + 0.5 * cos(phase + 0.0),
    0.5 + 0.5 * cos(phase + 2.094), // +120 degrees
    0.5 + 0.5 * cos(phase + 4.188)  // +240 degrees
  );
  
  vec3 baseColor = mix(uColor1, uColor2, flowColor.g * 0.5 + 0.25);
  // Blend spectral color as a premium sheen on top of the base state colors
  baseColor = mix(baseColor, spectralColor * uColor1 * 1.5, 0.20);

  // Displacement self-shadow — wave crests catch light, troughs fall into shadow.
  // With new smaller per-wave amplitudes (typical ±0.15 units vs old ±0.9),
  // the multiplier must be higher (2.5 vs 1.2) to create the same visual contrast.
  // At d=+0.15 (crest): 2.5*0.15+1 = 1.375 → 1.35 (bright).
  // At d=-0.15 (trough): 2.5*(-0.15)+1 = 0.625 → 0.62 (dark).
  // Full range used for typical single-swell displacement — smooth gradient.
  float dispBright = clamp(vDisplacement * 2.5 + 1.0, 0.60, 1.35);
  baseColor *= dispBright;

  // ===================================================================
  // 3D LIGHTING — Key + fill + directional rim + shadow occlusion
  //
  // WHY THIS MATTERS FOR 3D:
  //   The brain perceives sphere curvature primarily through the shading
  //   gradient from lit → shadow side. All additive effects (SSS, env,
  //   caustics) FLATTEN this gradient by adding energy to the dark side.
  //   Shadow occlusion attenuates these additive effects on the unlit
  //   hemisphere, preserving the contrast that reads as curvature.
  //
  //   Directional rim light (vs. symmetric Fresnel rim) creates ASYMMETRIC
  //   edge brightness: top edge bright, bottom dark. This asymmetry is
  //   the "lit from a specific direction" cue that separates 3D objects
  //   from flat circles. Apple/Copilot-grade orb quality.
  // ===================================================================
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPosition);

  // Key light: upper-right-forward (warm, primary shadow-caster)
  vec3 baseKeyDir = normalize(vec3(0.4, 0.7, 0.6));
  // Shift key light toward mouse position when active
  vec3 mouseLightDir = normalize(uMousePos - vec3(0.0));
  vec3 keyDir = normalize(mix(baseKeyDir, mouseLightDir, uMouseActive * 0.35));
  float keyDiffuse = max(dot(N, keyDir), 0.0);

  // Fill light: lower-left (cool, softer — prevents pitch-black shadow)
  vec3 fillDir = normalize(vec3(-0.3, -0.4, 0.5));
  float fillDiffuse = max(dot(N, fillDir), 0.0) * 0.3;

  // Ambient: low for genuine shadow depth that defines curvature
  float ambient = 0.10;

  // Combined diffuse
  float lighting = ambient + keyDiffuse * 0.70 + fillDiffuse;

  // --- Shadow occlusion: dark side gets reduced additive effects ---
  // Without this, SSS/env/caustics fill in the shadow uniformly → flat disc.
  // With it, the dark hemisphere stays genuinely dark → visible curvature.
  float shadowOccl = 0.30 + 0.70 * keyDiffuse;

  // --- Dual-Lobe Specular: clearcoat over broad base highlight ---
  // Power 32 for broad base highlight, Power 256 for razor-sharp core.
  vec3 halfDir = normalize(keyDir + V);
  float ndh = max(dot(N, halfDir), 0.0);
  float specBase = pow(ndh, 32.0) * 0.3;
  float specCore = pow(ndh, 256.0) * 0.5;
  float specBoost = 1.0 + uHighMid * 0.6;
  vec3 specColor = mix(vec3(1.0), uColor1, 0.3) * (specBase + specCore) * 0.45 * specBoost;

  // Secondary specular: soft broad highlight from the back-light direction.
  // Two catchlights (front key + back fill) = "environment lighting" = premium.
  vec3 backLightDir = normalize(vec3(0.1, 0.5, -0.9));
  vec3 halfBack = normalize(-backLightDir + V);
  float specBack = pow(max(dot(N, halfBack), 0.0), 32.0) * 0.20;
  specColor += mix(vec3(1.0), uColor1, 0.15) * specBack;

  // --- Directional rim light (behind-above, ASYMMETRIC silhouette) ---
  // Unlike Fresnel rim (symmetric all-edge glow), this is DIRECTIONAL:
  // bright crescent only on the upper silhouette where the back-light catches
  // the rim. Bottom edge stays dark. This asymmetry is what makes a sphere
  // look "lit from behind" rather than just "glowing at edges."
  float backFacing = max(dot(N, backLightDir), 0.0);
  float dirRim = fresnel * backFacing;
  vec3 dirRimColor = mix(vec3(1.0), uColor1, 0.20) * dirRim * 0.50;

  // --- Fresnel rim glow (symmetric base edge glow with Chromatic Dispersion) ---
  // RGB channel splitting simulates thick glass/water refraction at grazing angles.
  // Audio pulse modulates emissive intensity: rim brightens with speech rhythm.
  float trebleShimmer = 1.0 + uTreble * 0.3;
  float emissiveAudioMul = 1.0 + uAudioPulse * 0.35;
  float fR = pow(clamp(vFresnel - 0.02, 0.0, 1.0), uFresnelPower);
  float fG = pow(clamp(vFresnel, 0.0, 1.0), uFresnelPower);
  float fB = pow(clamp(vFresnel + 0.02, 0.0, 1.0), uFresnelPower);
  vec3 dispFresnel = vec3(fR, fG, fB);
  vec3 rimColor = mix(uColor1, vec3(1.0), 0.12) * dispFresnel * uEmissiveIntensity * trebleShimmer * emissiveAudioMul;

  // --- Physical Thickness-Based Subsurface Scattering ---
  // Wave troughs (thin areas) transmit more light, crests (thick areas) occlude.
  float localThickness = clamp(vDisplacement * 2.0 + 0.5, 0.1, 1.0);
  float thicknessMod = 1.0 / (localThickness + 0.1); // Thinner = brighter
  
  float sssAudioMul = 1.0 + uAudioPulse * 0.25;
  vec3 baseSssDir = normalize(keyDir + N * 0.3);
  vec3 sssDir = normalize(mix(baseSssDir, mouseLightDir, uMouseActive * 0.5));
  float wrap = 0.5;
  float sssDot = (dot(V, -sssDir) + wrap) / (1.0 + wrap);
  
  // Apply thickness modifier to SSS
  float sss = pow(max(sssDot, 0.0), 2.0) * 0.35 * thicknessMod;
  vec3 sssColor = uColor1 * 1.8 * sss * uSSSIntensity * shadowOccl * sssAudioMul;

  // --- Environment reflection (shadow-occluded analytical matcap) ---
  vec3 viewN = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  float envUp = smoothstep(-0.2, 0.8, viewN.y);
  vec3 envColor = mix(uColor2 * 0.4, uColor1 * 0.5 + vec3(0.15, 0.18, 0.25), envUp);
  float envStrength = uEnvReflect * (0.05 + fresnel * 0.12) * shadowOccl;

  // --- Combine: lit surface + 2 speculars + 2 rims + SSS + env ---
  vec3 finalColor = baseColor * lighting + specColor + rimColor + dirRimColor + sssColor;
  finalColor += envColor * envStrength;

  // Audio brightness: energy pulse (doubled from 0.05 for visible speech rhythm)
  finalColor += uAudioLevel * uAudioSens * 0.10 * uColor1;

  // --- Pseudo-Voronoi Caustics (shadow-occluded, speech-reactive) ---
  // More organic, moving light web resembling pool floor caustics
  vec3 cPos = vWorldPosition * 2.5 + vec3(uTime * 0.3, uTime * 0.2, -uTime * 0.25);
  vec3 cPos2 = vWorldPosition * 3.0 - vec3(uTime * 0.15, -uTime * 0.3, uTime * 0.2);
  
  // Fast pseudo-voronoi using crossing absolute sine ridges
  // Avoids sin(x*y) to prevent circular moiré patterns
  float n1 = sin(cPos.x) + sin(cPos.y) + sin(cPos.z);
  float n2 = sin(cPos2.x) + sin(cPos2.y) + sin(cPos2.z);
  
  float ridge1 = 1.0 - abs(n1 * 0.333);
  float ridge2 = 1.0 - abs(n2 * 0.333);
  
  float voronoi = pow(ridge1 * ridge2, 3.0) * 2.5;
  
  float caustic = max(0.0, voronoi);
  finalColor += uColor1 * caustic * (0.2 + uAudioPulse * 0.12) * shadowOccl;

  // --- Main window brightness boost ---
  float brightnessLift = mix(1.25, 1.0, uAlphaBoost);
  finalColor *= brightnessLift;

  // --- Saturation boost ---
  float lum = dot(finalColor, vec3(0.2126, 0.7152, 0.0722));
  finalColor = mix(vec3(lum), finalColor, 1.50);

  // --- ACES filmic tone mapping ---
  finalColor = aces(finalColor);

  // --- Fresnel-based alpha (translucent water-glass) ---
  // Center: 0.58 (deep color saturation without dark-bg bleed-through).
  // Edges: 0.88 (Fresnel-driven bright rim — visible even on wave crests).
  // Wave crests thin slightly (light passes through peaks) — with new smaller
  // per-wave displacement (±0.15), multiplier 0.12 creates ~2% alpha variation.
  float alpha = mix(0.58, 0.88, pow(fresnel, 2.0));
  alpha -= abs(vDisplacement) * 0.12;
  alpha = clamp(alpha, 0.48, 0.88);
  alpha = mix(alpha, 0.95, uAlphaBoost);

  gl_FragColor = vec4(finalColor, alpha);
}
`;

// ============================================================================
// Atmosphere Vertex Shader
// Points distributed in a spherical shell with gentle orbital drift.
// Audio-reactive radial velocity and jitter. Size attenuation for depth.
// ============================================================================

const ATMO_VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uAtmoSize;
uniform float uBreathScale;
uniform float uAudioLevel;
uniform float uRadiusScale;

attribute float aPhase;

varying float vAlpha;

void main() {
  // Gentle orbital drift per particle
  float angle = aPhase + uTime * 0.08;
  vec3 pos = position;
  pos.x += sin(angle) * 0.12;
  pos.y += cos(angle * 0.7 + 1.5) * 0.08;
  pos.z += cos(angle) * 0.12;

  // State-driven radial push/pull (listening contracts, speaking expands)
  pos *= uRadiusScale;

  // Audio-reactive jitter along radial direction
  pos += normalize(pos) * sin(aPhase * 7.0 + uTime * 3.0) * uAudioLevel * 0.3;

  // Apply breathing scale to atmosphere too
  pos *= uBreathScale;

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);

  // Size attenuation: small droplet motes. uAtmoSize ~0.25 gives ~8-14px on screen.
  gl_PointSize = uAtmoSize * (200.0 / max(-mvPos.z, 1.0));
  gl_Position = projectionMatrix * mvPos;

  // Depth-based alpha: inner particles brighter, outer fade out.
  // Base 0.10 (up from 0.04) so particles are actually visible as distinct droplets.
  float dist = length(position);
  vAlpha = smoothstep(4.5, 2.0, dist) * 0.10;
}
`;

// ============================================================================
// Atmosphere Fragment Shader
// Soft gaussian circle with additive blending.
// ============================================================================

const ATMO_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uAtmoColor;
uniform float uTime;

varying float vAlpha;

void main() {
  vec2 center = gl_PointCoord - 0.5;
  float dist = length(center);
  if (dist > 0.5) discard;

  // --- Water droplet: bright specular core + soft surrounding halo ---
  // Core: very tight gaussian — simulates a light refraction pinpoint.
  float core = exp(-dist * dist * 60.0);
  // Halo: softer gaussian — the translucent body of the droplet.
  float halo = exp(-dist * dist * 14.0);
  // Combined: 60% bright core, 40% soft body = clear droplet, not foggy blob.
  float shape = core * 0.6 + halo * 0.4;

  // --- Chromatic edge tint (water refraction shifts blue at edges) ---
  // Inner region stays at the state color; outer ring picks up cool blue.
  vec3 color = uAtmoColor;
  float edgeMix = smoothstep(0.1, 0.45, dist);
  color = mix(color, color * vec3(0.7, 0.85, 1.3), edgeMix * 0.4);

  // --- Subtle per-particle twinkle (phase from gl_PointCoord for variety) ---
  float twinkle = 0.85 + 0.15 * sin(uTime * 3.0 + gl_PointCoord.x * 31.4 + gl_PointCoord.y * 17.3);
  shape *= twinkle;

  float alpha = shape * vAlpha;
  if (alpha < 0.001) discard;

  gl_FragColor = vec4(color, alpha);
}
`;

// ============================================================================
// State Parameter Table
// Each AI state defines a complete set of visual parameters.
// Visualizer.js lerps between current and target params each frame.
// ============================================================================

// noiseAmp calibration (ocean planet v3 — sphere-calibrated spatial frequencies):
//   Wave weights: swell1(0.9) + swell2(0.7) + wind(0.35*storm) + chop(0.18*storm)
//   Raw constructive peak ≈ 1.6+0.53 = 2.13, after pow(x, 0.85) ≈ 1.95.
//   Displacement = noiseAmp * ~1.95 world units, clamped to ±0.55 (orbRadius 1.8).
//   Negative = inward troughs. Positive = outward crests.
//   Target: idle 0.14 → ±0.27 (15% radius), error 0.25 → ±0.49 (27% radius).
//   SPATIAL FREQUENCIES calibrated to sphere: 3-5 visible crests per hemisphere.
//   Previous version had waves 10x bigger than the sphere (invisible).
const COSMOS_STATE_PARAMS = {
  idle: {
    noiseAmp: 0.14,           // 0.14 * 1.95 = 0.27 → 15% radius — visible rolling ocean
    noiseSpeed: 0.38,
    radiusScale: 1.0,
    color1: [0.40, 0.52, 0.88],    // Periwinkle blue
    color2: [0.25, 0.35, 0.68],    // Deeper blue
    breathRate: 1.2,
    breathDepth: 0.008,       // Max swing ±1.3% — imperceptible. Waves provide all "alive" feel.
    audioSens: 0.3,
    fresnelPower: 2.2,
    emissiveIntensity: 0.45,
    flowSpeed: 0.40,
    bloomStrength: 0.10,
    sssIntensity: 0.55,
    envReflect: 0.20,
    sh: [0, 0, 0, 0, 0, 0, 0, 0, 0],  // Pure sphere
  },
  listening: {
    noiseAmp: 0.19,           // 0.19 * 1.95 = 0.37 → 21% radius — heavy seas during STT
    noiseSpeed: 0.58,         // Base wave speed (+ dynamic audio boost up to +0.35 during STT)
    radiusScale: 0.94,
    color1: [0.10, 0.55, 0.92],    // Electric blue
    color2: [0.05, 0.30, 0.70],    // Deep blue
    breathRate: 4.0,
    breathDepth: 0.008,       // Max swing ±1.3% — audio reactivity provides the energy, not scaling
    audioSens: 1.0,
    fresnelPower: 2.0,
    emissiveIntensity: 0.60,
    flowSpeed: 0.60,
    bloomStrength: 0.16,
    sssIntensity: 0.75,
    envReflect: 0.18,
    sh: [0, -0.15, 0, 0, 0, 0, -0.08, 0, 0],  // Compressed top — absorbing
  },
  speaking: {
    noiseAmp: 0.18,           // 0.18 * 1.95 = 0.35 → 19% radius (+ audioPulse 60% boost on swells)
    noiseSpeed: 0.48,         // Base wave speed (+ dynamic audio boost up to +0.35 during TTS)
    radiusScale: 1.06,
    color1: [0.88, 0.45, 0.08],    // Warm amber
    color2: [0.68, 0.28, 0.05],    // Deep orange
    breathRate: 2.5,
    breathDepth: 0.009,       // Max swing ±1.4% — TTS audio drives visual, not uniform pulse
    audioSens: 0.9,
    fresnelPower: 2.2,
    emissiveIntensity: 0.55,
    flowSpeed: 0.58,          // Iridescent flow faster during speech for visible surface activity
    bloomStrength: 0.18,
    sssIntensity: 0.85,
    envReflect: 0.22,
    sh: [0.02, 0, 0, 0, 0, 0, 0.15, 0, 0],  // Elongated vertically — projecting
  },
  thinking: {
    noiseAmp: 0.22,           // 0.22 * 1.95 = 0.43 → 24% radius — storm-tossed ocean
    noiseSpeed: 0.52,
    radiusScale: 1.0,
    color1: [0.12, 0.62, 0.68],    // Teal
    color2: [0.05, 0.40, 0.50],    // Deep teal
    breathRate: 3.0,
    breathDepth: 0.009,       // Max swing ±1.4% — wave turbulence is the visual, not scaling
    audioSens: 0.2,
    fresnelPower: 2.0,
    emissiveIntensity: 0.50,
    flowSpeed: 0.65,
    bloomStrength: 0.14,
    sssIntensity: 0.95,
    envReflect: 0.18,
    sh: [0, 0, 0, 0, 0.12, 0.08, 0, 0.10, 0.06],  // Asymmetric blob — churning
  },
  working: {
    noiseAmp: 0.16,           // 0.16 * 1.95 = 0.31 → 17% radius
    noiseSpeed: 0.45,
    radiusScale: 1.0,
    color1: [0.12, 0.58, 0.72],    // Cyan
    color2: [0.05, 0.35, 0.58],    // Blue-cyan
    breathRate: 2.0,
    breathDepth: 0.008,       // Max swing ±1.3% — stable work state
    audioSens: 0.2,
    fresnelPower: 2.2,
    emissiveIntensity: 0.48,
    flowSpeed: 0.55,
    bloomStrength: 0.12,
    sssIntensity: 0.65,
    envReflect: 0.18,
    sh: [0, 0, 0, 0, 0, 0, 0.08, 0, 0],  // Slightly elongated
  },
  waiting: {
    noiseAmp: 0.11,           // 0.11 * 1.95 = 0.21 → 12% radius — gentle but visible swells
    noiseSpeed: 0.30,
    radiusScale: 1.0,
    color1: [0.75, 0.58, 0.12],    // Warm yellow
    color2: [0.55, 0.40, 0.08],    // Gold
    breathRate: 1.0,
    breathDepth: 0.006,       // Max swing ±1.0% — calm waiting state
    audioSens: 0.2,
    fresnelPower: 2.5,
    emissiveIntensity: 0.42,
    flowSpeed: 0.35,
    bloomStrength: 0.08,
    sssIntensity: 0.50,
    envReflect: 0.20,
    sh: [0, -0.05, 0, 0, 0, 0, -0.05, 0, 0],  // Slightly compressed — settled
  },
  offline: {
    noiseAmp: 0.15,           // 0.15 * 1.95 = 0.29 → 16% radius — visible rolling ocean
    noiseSpeed: 0.34,         // Noticeable motion
    radiusScale: 1.0,         // No shrinking — same size as idle
    color1: [0.10, 0.32, 0.62],    // Deep ocean blue (reads as water, not pastel)
    color2: [0.05, 0.14, 0.40],    // Dark abyss navy (high contrast with color1)
    breathRate: 1.0,
    breathDepth: 0.005,       // Max swing ±0.8% — stable size. Waves provide visual life.
    audioSens: 0.0,
    fresnelPower: 2.0,        // Broader rim for wet-glass edge
    emissiveIntensity: 0.28,  // LOW — water absorbs light, doesn't glow. Contrast comes from spec.
    flowSpeed: 0.35,          // Visible iridescent flow
    bloomStrength: 0.08,
    sssIntensity: 0.30,       // LOWER — real water has subtle SSS, not luminescent glow
    envReflect: 0.28,         // HIGHER — wet surface reflects environment. Reads as "liquid."
    sh: [0, 0, 0, 0, 0, 0, 0, 0, 0],  // Pure sphere — no contraction
  },
  error: {
    noiseAmp: 0.25,           // 0.25 * 1.95 = 0.49 → 27% radius — violent storm
    noiseSpeed: 0.75,
    radiusScale: 1.0,
    color1: [0.88, 0.12, 0.08],    // Bright red
    color2: [0.62, 0.0, 0.0],      // Deep red
    breathRate: 6.0,
    breathDepth: 0.012,       // Max swing ±1.9% — error uses wave violence, not size pulsing
    audioSens: 0.0,
    fresnelPower: 1.8,
    emissiveIntensity: 0.65,
    flowSpeed: 0.85,
    bloomStrength: 0.20,
    sssIntensity: 0.45,
    envReflect: 0.15,
    sh: [0, 0, 0, 0, 0.15, -0.12, 0.10, 0.13, -0.10],  // Distorted — error state
  },
};

// ============================================================================
// Exports
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ORB_VERTEX_SHADER,
    ORB_FRAGMENT_SHADER,
    ATMO_VERTEX_SHADER,
    ATMO_FRAGMENT_SHADER,
    COSMOS_STATE_PARAMS,
  };
}
