/**
 * 100% Royalty-Free Procedural Backing Beat & Ringside SFX Synthesizer.
 * Generates a 24kHz 16-bit PCM WAV audio bed locked to exact timeline millisecond cues,
 * leaving the 300Hz–3.5kHz vocal midrange open and pairing with FFmpeg sidechain ducking.
 */

const SAMPLE_RATE = 24000;

function writeWavHeader(numSamples) {
  const dataSize = numSamples * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(1, 22);  // Mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // Byte rate
  header.writeUInt16LE(2, 32);  // Block align
  header.writeUInt16LE(16, 34); // Bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

// Deterministic fast PRNG for consistent hi-hat/snare noise textures
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addKick(mix, startSample, amp = 0.24) {
  const dur = Math.floor(SAMPLE_RATE * 0.22);
  let phase = 0;
  for (let i = 0; i < dur && startSample + i < mix.length; i++) {
    const t = i / SAMPLE_RATE;
    const freq = 44 + 78 * Math.exp(-t * 34);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const env = Math.exp(-t * 11.5);
    mix[startSample + i] += Math.tanh(Math.sin(phase) * 1.45) * env * amp;
  }
}

function addSnare(mix, startSample, rand, amp = 0.13) {
  const dur = Math.floor(SAMPLE_RATE * 0.14);
  let phase = 0;
  let prevNoise = 0;
  for (let i = 0; i < dur && startSample + i < mix.length; i++) {
    const t = i / SAMPLE_RATE;
    phase += (2 * Math.PI * 178) / SAMPLE_RATE;
    const rawNoise = rand() * 2 - 1;
    const hpNoise = rawNoise - prevNoise * 0.62;
    prevNoise = rawNoise;
    const body = Math.sin(phase) * Math.exp(-t * 28) * 0.45;
    const snap = hpNoise * Math.exp(-t * 21) * 0.75;
    mix[startSample + i] += (body + snap) * amp;
  }
}

function addHat(mix, startSample, rand, amp = 0.045, decay = 48) {
  const dur = Math.floor(SAMPLE_RATE * 0.055);
  let prev = 0;
  for (let i = 0; i < dur && startSample + i < mix.length; i++) {
    const t = i / SAMPLE_RATE;
    const n = rand() * 2 - 1;
    const hp = n - prev * 0.86;
    prev = n;
    mix[startSample + i] += hp * Math.exp(-t * decay) * amp;
  }
}

/** Ringside metallic round bell cue. */
function addBoxingBell(mix, startSample, amp = 0.20) {
  const dur = Math.floor(SAMPLE_RATE * 0.85);
  const partials = [
    [784, 1.0, 4.2],
    [1188, 0.65, 5.8],
    [1792, 0.42, 7.5],
    [2480, 0.25, 10.5],
  ];
  for (let i = 0; i < dur && startSample + i < mix.length; i++) {
    if (startSample + i < 0) continue;
    const t = i / SAMPLE_RATE;
    let s = 0;
    for (const [f, w, d] of partials) {
      s += Math.sin(2 * Math.PI * f * t) * w * Math.exp(-t * d);
    }
    const attack = Math.min(1, i / 48);
    mix[startSample + i] += s * attack * amp * 0.5;
  }
}

/** Turn-switch whoosh cue when Corner B takes the mic. */
function addTurnWhoosh(mix, startSample, rand, amp = 0.11) {
  const dur = Math.floor(SAMPLE_RATE * 0.22);
  let lp = 0;
  for (let i = 0; i < dur && startSample + i < mix.length; i++) {
    if (startSample + i < 0) continue;
    const p = i / dur;
    const env = Math.sin(Math.PI * p);
    const n = rand() * 2 - 1;
    const cutoff = 0.08 + 0.35 * p;
    lp += cutoff * (n - lp);
    mix[startSample + i] += (n - lp) * env * amp;
  }
}

/** Cinematic sub-bass impact drop for Judge Score & Final Verdict reveals. */
function addSubDrop(mix, startSample, amp = 0.26) {
  const dur = Math.floor(SAMPLE_RATE * 0.48);
  let phase = 0;
  for (let i = 0; i < dur && startSample + i < mix.length; i++) {
    if (startSample + i < 0) continue;
    const t = i / SAMPLE_RATE;
    const freq = 35 + 72 * Math.exp(-t * 8.5);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const env = Math.min(1, i / 72) * Math.exp(-t * 4.8);
    mix[startSample + i] += Math.tanh(Math.sin(phase) * 1.35) * env * amp;
  }
}

/**
 * Synthesize a complete WAV Buffer containing the mode-appropriate backing groove
 * plus timeline-locked ringside SFX (round bell, turn whoosh, verdict sub-drop).
 */
export function synthesizeBattleBedWav({
  mode = 'rap',
  totalDurationMs = 45000,
  leadInMs = 0,
  timeline = [],
} = {}) {
  const totalSec = Math.max(2, (leadInMs + totalDurationMs + 800) / 1000);
  const numSamples = Math.ceil(totalSec * SAMPLE_RATE);
  const mix = new Float32Array(numSamples);
  const rand = mulberry32(0xb07b4a11);

  const energetic = mode === 'rap' || mode === 'roast';
  const bpm = energetic ? 92 : 74;
  const stepSec = 60 / bpm / 4; // 16th-note grid
  const totalSteps = Math.floor(totalSec / stepSec);

  // Bass root progression per bar (C2, C2, Ab1, G1) — dark studio arena motif
  const bassRoots = [65.41, 65.41, 51.91, 49.0];

  for (let step = 0; step < totalSteps; step++) {
    const pos = Math.floor(step * stepSec * SAMPLE_RATE);
    const stepInBar = step % 16;
    const barIdx = Math.floor(step / 16);

    if (energetic) {
      // Boom-bap / 808 pattern: kicks on 0, 6, 10 (and occasional turnaround on 14)
      if (stepInBar === 0 || stepInBar === 6 || stepInBar === 10 || (barIdx % 2 === 1 && stepInBar === 14)) {
        addKick(mix, pos, stepInBar === 0 ? 0.22 : 0.17);
      }
      // Snare on beats 2 & 4 (steps 4 & 12)
      if (stepInBar === 4 || stepInBar === 12) {
        addSnare(mix, pos, rand, 0.12);
      }
      // Crisp 8th/16th hi-hats
      if (stepInBar % 2 === 0) {
        addHat(mix, pos, rand, stepInBar % 4 === 2 ? 0.05 : 0.032, 52);
      } else if (stepInBar === 7 || stepInBar === 15) {
        addHat(mix, pos, rand, 0.024, 65);
      }

      // Warm sub-bass note on downbeat & half-bar
      if (stepInBar === 0 || stepInBar === 8) {
        const root = bassRoots[barIdx % bassRoots.length];
        const noteDur = Math.floor(stepSec * 6.5 * SAMPLE_RATE);
        for (let i = 0; i < noteDur && pos + i < numSamples; i++) {
          const t = i / SAMPLE_RATE;
          const env = Math.min(1, i / 180) * Math.exp(-t * 2.6);
          mix[pos + i] += Math.sin(2 * Math.PI * root * t) * env * 0.095;
        }
      }
    } else {
      // Atmospheric pulse for Debate, Poetry, Story
      if (stepInBar === 0 || stepInBar === 10) {
        addKick(mix, pos, stepInBar === 0 ? 0.13 : 0.09);
      }
      if (stepInBar === 8) {
        addHat(mix, pos, rand, 0.025, 38);
      }
      if (stepInBar === 0) {
        const root = bassRoots[barIdx % bassRoots.length];
        const padDur = Math.floor(stepSec * 14 * SAMPLE_RATE);
        for (let i = 0; i < padDur && pos + i < numSamples; i++) {
          const t = i / SAMPLE_RATE;
          const env = Math.sin(Math.PI * (i / padDur));
          mix[pos + i] += (Math.sin(2 * Math.PI * root * t) + 0.35 * Math.sin(2 * Math.PI * root * 1.5 * t)) * env * 0.045;
        }
      }
    }
  }

  // Layer exact timeline SFX cues
  for (const seg of timeline) {
    const cueMs = Math.max(0, leadInMs + (Number(seg.startMs) || 0) - 90);
    const cueSample = Math.floor((cueMs / 1000) * SAMPLE_RATE);
    if (seg.type === 'verse' && seg.side === 'a') {
      addBoxingBell(mix, cueSample, 0.22);
    } else if (seg.type === 'verse' && seg.side === 'b') {
      addTurnWhoosh(mix, cueSample, rand, 0.12);
    } else if (seg.type === 'judge' || seg.type === 'outro') {
      addSubDrop(mix, cueSample, 0.24);
      if (seg.type === 'outro') {
        addBoxingBell(mix, cueSample + Math.floor(SAMPLE_RATE * 0.08), 0.18);
      }
    }
  }

  // Fade out last 600ms smoothly and convert Float32 -> 16-bit PCM
  const fadeSamples = Math.min(numSamples, Math.floor(SAMPLE_RATE * 0.6));
  for (let i = 0; i < fadeSamples; i++) {
    const idx = numSamples - 1 - i;
    mix[idx] *= i / fadeSamples;
  }

  const pcm = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-0.95, Math.min(0.95, mix[i]));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  return Buffer.concat([writeWavHeader(numSamples), pcm]);
}

