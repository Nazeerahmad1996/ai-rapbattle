/**
 * Pure Frame-Deterministic Motion Primitives (`f(frame) -> value`).
 * Remotion-style `interpolate()`, analytical damped `spring()`, easing curves,
 * and 6-frame capped punchline `dampedShake()` — shared by Node tests and `director.js`.
 */

export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function easeOutExpo(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.pow(2, -10 * t);
}

export function easeOutCubic(t) {
  const u = clamp(t, 0, 1);
  return 1 - Math.pow(1 - u, 3);
}

export function easeInCubic(t) {
  const u = clamp(t, 0, 1);
  return u * u * u;
}

export function easeInOutCubic(t) {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/** Approximation of Material Design 3 Snappy curve `cubic-bezier(0.2, 0, 0, 1)`. */
export function md3Snappy(t) {
  const u = clamp(t, 0, 1);
  return 1 - Math.pow(1 - u, 3.6);
}

/** Periodic C1 pulse: both the value and velocity match at each beat boundary. */
export function beatPulse(tMs, beatMs = 666.67, offsetMs = 0) {
  if (tMs < offsetMs) return 0;
  const phase = ((tMs - offsetMs) % beatMs) / beatMs;
  // A brief eased attack lands the accent near the audible downbeat, then
  // releases fully before the next beat without an exponential-reset snap.
  const attack = 0.08;
  const release = 0.5;
  if (phase < attack) return Math.sin(Math.PI * 0.5 * phase / attack) ** 2;
  if (phase < release) return Math.cos(Math.PI * 0.5 * (phase - attack) / (release - attack)) ** 2;
  return 0;
}

/**
 * Analytical response to a sequence of target changes. Superposing the step
 * responses preserves position AND velocity when a new cue interrupts a move.
 * Sampling/seeking never depends on the previously rendered frame.
 */
export function springTrack(tMs, steps, initial = 0, preset = SPRING_PRESETS.camera) {
  let value = initial;
  let previous = initial;
  for (const step of steps) {
    if (step.startMs > tMs) break;
    value += (step.value - previous) * spring({ frame: tMs - step.startMs, fps: 1000, ...preset });
    previous = step.value;
  }
  return value;
}

/**
 * Remotion-compatible clamped piecewise linear/eased interpolation.
 * Never extrapolates past boundaries by default (`clamp: true`).
 */
export function interpolate(value, inputRange, outputRange, { easing = x => x, clampOut = true } = {}) {
  if (!Array.isArray(inputRange) || !Array.isArray(outputRange) || inputRange.length < 2) {
    return outputRange?.[0] ?? 0;
  }
  if (value <= inputRange[0]) {
    if (clampOut) return outputRange[0];
  }
  const last = inputRange.length - 1;
  if (value >= inputRange[last]) {
    if (clampOut) return outputRange[last];
  }

  let seg = 0;
  for (let i = 0; i < last; i++) {
    if (value >= inputRange[i] && value <= inputRange[i + 1]) {
      seg = i;
      break;
    }
  }

  const inMin = inputRange[seg];
  const inMax = inputRange[seg + 1];
  const outMin = outputRange[seg];
  const outMax = outputRange[seg + 1];
  const span = inMax - inMin;
  const rawProgress = span === 0 ? 1 : clamp((value - inMin) / span, 0, 1);
  const eased = easing(rawProgress);
  return outMin + eased * (outMax - outMin);
}

/**
 * Closed-form analytical damped harmonic oscillator (`0 -> 1`).
 * Matches physical spring dynamics without stateful frame accumulation!
 *
 * Presets:
 * - `slamSpring`:   { stiffness: 380, damping: 24, mass: 0.9 } (~5% crisp impact overshoot)
 * - `cameraSpring`: { stiffness: 220, damping: 26, mass: 1.0 } (critically damped, 0% wobble)
 */
export function spring({
  frame,
  fps = 30,
  delayFrames = 0,
  stiffness = 300,
  damping = 24,
  mass = 1,
} = {}) {
  const localFrame = frame - delayFrames;
  if (localFrame <= 0) return 0;
  const t = localFrame / Math.max(1, fps);

  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta < 1) {
    // Underdamped
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * omega0 * t);
    const oscillation =
      Math.cos(omegaD * t) + ((zeta * omega0) / omegaD) * Math.sin(omegaD * t);
    return 1 - envelope * oscillation;
  }
  if (Math.abs(zeta - 1) < 1e-4) {
    // Critically damped
    return 1 - (1 + omega0 * t) * Math.exp(-omega0 * t);
  }
  // Overdamped
  const s = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega0 * (zeta - s);
  const r2 = -omega0 * (zeta + s);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

export const SPRING_PRESETS = {
  slam: { stiffness: 380, damping: 24, mass: 0.9 },
  camera: { stiffness: 220, damping: 28, mass: 1.0 },
  scorePop: { stiffness: 420, damping: 22, mass: 0.85 },
  whip: { stiffness: 340, damping: 26, mass: 0.95 },
};

/**
 * Deterministic punchline camera shake — strictly capped at `maxFrames` (default 5 frames <= 6 frame limit).
 * Returns `{ x, y, rotDeg, scaleBoost }` decaying smoothly to exact 0 at `onsetFrame + maxFrames`.
 */
export function dampedShake({
  frame,
  onsetFrame,
  maxFrames = 5,
  fps = 30,
  durationMs = null,
  ampPx = 14,
  rotAmpDeg = 1.1,
  scalePunch = 0.045,
} = {}) {
  const elapsedMs = (frame - onsetFrame) * 1000 / fps;
  const duration = durationMs ?? maxFrames * 1000 / 30;
  if (elapsedMs < 0 || elapsedMs >= duration) {
    return { x: 0, y: 0, rotDeg: 0, scaleBoost: 0 };
  }
  const progress = elapsedMs / duration;
  // Smooth attack and release; oscillation frequency is measured in seconds,
  // so a 60 fps export follows the same movement as a 30 fps preview.
  const decay = Math.sin(Math.PI * progress) ** 2 * (1 - progress);
  const seconds = elapsedMs / 1000;
  const x = Math.sin(seconds * Math.PI * 2 * 13) * ampPx * decay;
  const y = Math.sin(seconds * Math.PI * 2 * 17) * (ampPx * 0.72) * decay;
  const rotDeg = Math.sin(seconds * Math.PI * 2 * 11) * rotAmpDeg * decay;
  const scaleBoost = scalePunch * decay;
  return { x, y, rotDeg, scaleBoost };
}

