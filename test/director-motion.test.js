import test from 'node:test';
import assert from 'node:assert/strict';
import { beatPulse, springTrack, dampedShake, SPRING_PRESETS } from '../public/motion-math.js';

test('beat envelope has continuous position and velocity at beat boundaries', () => {
  const beat = 666.67;
  const epsilon = 0.001;
  for (const onset of [beat, beat * 2, beat * 3]) {
    assert.ok(Math.abs(beatPulse(onset - epsilon, beat) - beatPulse(onset + epsilon, beat)) < 1e-9);
    assert.ok(Math.abs((beatPulse(onset + epsilon, beat) - beatPulse(onset, beat)) / epsilon) < 1e-6);
  }
  assert.equal(beatPulse(0, beat), 0);
  assert.equal(beatPulse(-100, beat), 0);
  assert.equal(beatPulse(beat * 0.08, beat), 1);
  assert.equal(beatPulse(beat / 2, beat), 0);
});

test('interrupted camera moves preserve position and velocity and support arbitrary seeks', () => {
  const first = [{ startMs: 0, value: 1.1 }];
  const interrupted = [...first, { startMs: 120, value: 0.99 }, { startMs: 210, value: 1.04 }];
  const epsilon = 0.001;
  assert.equal(springTrack(120, interrupted, 1), springTrack(120, first, 1));
  const before = (springTrack(120, first, 1) - springTrack(120 - epsilon, first, 1)) / epsilon;
  const after = (springTrack(120 + epsilon, interrupted, 1) - springTrack(120, interrupted, 1)) / epsilon;
  assert.ok(Math.abs(before - after) < 1e-6);
  const order = [400, 0, 210, 121, 6000, 120, 400];
  const samples = order.map(ms => springTrack(ms, interrupted, 1, SPRING_PRESETS.camera));
  assert.equal(samples[0], samples.at(-1));
  assert.ok(Math.abs(samples[4] - 1.04) < 1e-6);
});

test('impact motion is identical at equivalent timestamps in 30 and 60 fps exports', () => {
  for (let frame = 0; frame <= 8; frame++) {
    const at30 = dampedShake({ frame, onsetFrame: 0, fps: 30, durationMs: 165 });
    const at60 = dampedShake({ frame: frame * 2, onsetFrame: 0, fps: 60, durationMs: 165 });
    assert.deepEqual(at60, at30);
  }
  const zero = { x: 0, y: 0, rotDeg: 0, scaleBoost: 0 };
  assert.deepEqual(dampedShake({ frame: 0, onsetFrame: 0 }), zero);
  assert.deepEqual(dampedShake({ frame: 10, onsetFrame: 0, fps: 60, durationMs: 165 }), zero);
});
