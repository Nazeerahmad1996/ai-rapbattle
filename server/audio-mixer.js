/**
 * Phase 4 Studio 48 kHz Stereo Broadcast Audio Mixer & EBU R128 Master (`server/audio-mixer.js`).
 *
 * Architecture:
 * 1. Sample-accurate 3-bus assembly (`scripts/mix_buses.py` at 48 kHz Stereo):
 *    - `vocals-bus.wav` (per-line stems with subtle L/R corner placement)
 *    - `music-bus.wav`  (CC0 48 kHz Stereo beat loop + smooth pre-punchline `beat-dropout` cuts)
 *    - `sfx-bus.wav`    (CC0 48 kHz Stereo foley kit obeying Vocals > SFX > Music hierarchy)
 * 2. Mode-specific dry vocal EQ/compression and sidechain ducking.
 * 3. Linear loudness targeting with a 4x oversampled, delay-compensated limiter.
 *    A conservative PCM ceiling reserves headroom for AAC encoding. Measure the
 *    encoded deliverable too: PCM metrics cannot certify codec true peaks.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_PYTHON } from './forced-aligner.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const MIX_BUSES_SCRIPT = join(ROOT_DIR, 'scripts', 'mix_buses.py');

/**
 * Measure exact EBU R128 Integrated Loudness (`I`), Loudness Range (`LRA`), and True Peak (`TP`)
 * plus audio stream sample rate and channel count on any WAV or MP4 file.
 */
export function measureAudioMetrics(mediaPath, ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe') {
  if (!mediaPath || !existsSync(mediaPath)) {
    throw new Error(`Audio file not found for measurement: ${mediaPath}`);
  }

  let sampleRateHz = 48000;
  let channels = 2;
  let durationSec = 0;
  try {
    const probeJson = execFileSync(
      ffprobeBin,
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate,channels,duration:format=duration',
        '-of', 'json',
        mediaPath,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    const parsed = JSON.parse(probeJson);
    const st = parsed?.streams?.[0] || {};
    sampleRateHz = Number(st.sample_rate) || 48000;
    channels = Number(st.channels) || 2;
    durationSec = Number(st.duration || parsed?.format?.duration || 0);
  } catch (error) { throw new Error(`Unable to probe audio: ${error.message}`); }

  const res = spawnSync(
    ffmpegBin,
    ['-hide_banner', '-nostats', '-i', mediaPath, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 60000 },
  );
  if (res.error || res.status !== 0) throw new Error(`Audio measurement failed: ${res.error?.message || res.stderr}`);
  const log = `${res.stdout || ''}\n${res.stderr || ''}`;

  // Parse final Summary block of ffmpeg ebur128
  const summaryIdx = log.lastIndexOf('Summary:');
  const tail = summaryIdx >= 0 ? log.slice(summaryIdx) : log;

  const matchNum = re => {
    const m = tail.match(re);
    return m ? Number(m[1]) : null;
  };

  const integratedLufs = matchNum(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  const loudnessRangeLu = matchNum(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/);
  const truePeakDbtp = matchNum(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/);
  if (![integratedLufs, loudnessRangeLu, truePeakDbtp].every(Number.isFinite)) {
    throw new Error(`No finite loudness measurements for ${mediaPath}`);
  }

  return {
    sampleRateHz,
    channels,
    durationSec: Number(durationSec.toFixed(3)),
    integratedLufs: Number(integratedLufs.toFixed(2)),
    loudnessRangeLu: Number(loudnessRangeLu.toFixed(2)),
    truePeakDbtp: Number(truePeakDbtp.toFixed(2)),
  };
}

/**
 * Detect silence intervals `>= minDurationSec` on an audio/video file via ffmpeg `silencedetect`.
 */
export function measureSilenceGaps(mediaPath, ffmpegBin = 'ffmpeg', { noiseDb = -36, minDurationSec = 0.24 } = {}) {
  const res = spawnSync(
    ffmpegBin,
    [
      '-hide_banner',
      '-nostats',
      '-i', mediaPath,
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`,
      '-f', 'null', '-',
    ],
    { encoding: 'utf8', timeout: 45000 },
  );
  const log = `${res.stdout || ''}\n${res.stderr || ''}`;
  const gaps = [];
  const re = /silence_end:\s*(\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(log)) !== null) {
    const endSec = Number(m[1]);
    const durSec = Number(m[2]);
    gaps.push({
      startSec: Number(Math.max(0, endSec - durSec).toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      durationSec: Number(durSec.toFixed(3)),
    });
  }
  return gaps;
}

/**
 * Render the complete 48 kHz Stereo mastered battle soundtrack (`master-audio.wav`).
 */
export function mixMasterBattleAudio({
  timelineV2,
  workDir,
  outputWavPath,
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe',
  beat = true,
  musicBaseVolume = 0.34,
  sfxBaseVolume = 0.72,
  sidechainRatio = 4.5,
  targetLufs = -14.0,
  masterGainTrimDb = 0.0,
}) {
  mkdirSync(workDir, { recursive: true });
  const specPath = join(workDir, 'mix-spec.json');
  writeFileSync(
    specPath,
    JSON.stringify({ timelineV2, outDir: workDir, beat }, null, 2),
    'utf8',
  );

  // 1. Assemble sample-locked 48 kHz Stereo buses
  const busJson = execFileSync(STUDIO_PYTHON, [MIX_BUSES_SCRIPT, '--spec', specPath], {
    encoding: 'utf8',
    timeout: 90000,
  });
  const buses = JSON.parse(busJson.trim().split('\n').at(-1));
  const { vocalsBus, musicBus, sfxBus } = buses;

  // Save dry vocals bus measurement check for breathing-gap QA if needed
  const premasterWav = join(workDir, 'premaster-48k.wav');

  // Spoken formats leave more space for the voice; rap retains a stronger beat.
  const mode = timelineV2?.mode || 'rap';
  const delivery = {
    rap: { music: 1.0, ratio: 2.4, release: 120, presence: 1.8 },
    roast: { music: 0.48, ratio: 2.1, release: 150, presence: 1.5 },
    debate: { music: 0.35, ratio: 2.0, release: 150, presence: 1.6 },
    poetry: { music: 0.42, ratio: 1.6, release: 210, presence: 0.8 },
    story: { music: 0.55, ratio: 1.8, release: 180, presence: 1.0 },
  }[mode] || { music: 0.5, ratio: 2.0, release: 160, presence: 1.2 };
  const effectiveMusicVol = musicBaseVolume * delivery.music;
  const totalSamples = Math.max(48000, Math.round(Number(timelineV2.totalDurationMs) * 48));
  // A dry direct voice preserves consonants and the caption timeline duration.
  const vocalChain = [
    'highpass=f=75',
    'equalizer=f=280:t=q:w=1.4:g=-1.5',
    `equalizer=f=3400:t=q:w=1.6:g=${delivery.presence}`,
    `acompressor=threshold=-18dB:ratio=${delivery.ratio}:attack=12:release=${delivery.release}:makeup=1.35`,
  ].join(',');

  const filterGraph = [
    `[0:a]${vocalChain},asplit=2[vox_sc][vox_main]`,
    `[1:a]volume=${effectiveMusicVol.toFixed(3)}[mus_pre]`,
    `[mus_pre][vox_sc]sidechaincompress=threshold=0.022:ratio=${sidechainRatio}:attack=14:release=190[mus_ducked]`,
    `[2:a]volume=${sfxBaseVolume.toFixed(3)}[sfx_in]`,
    `[vox_main][mus_ducked][sfx_in]amix=inputs=3:dropout_transition=0:normalize=0[pre]`,
  ].join(';');

  execFileSync(
    ffmpegBin,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', vocalsBus,
      '-i', musicBus,
      '-i', sfxBus,
      '-filter_complex', filterGraph,
      '-map', '[pre]',
      '-ar', '48000',
      '-ac', '2',
      '-c:a', 'pcm_f32le',
      premasterWav,
    ],
    { timeout: 90000 },
  );

  // 3. Pass 1: Measure Premaster EBU R128 Integrated Loudness
  const pass1 = measureAudioMetrics(premasterWav, ffmpegBin, ffprobeBin);
  const desiredLufs = targetLufs + masterGainTrimDb;
  let gainDb = desiredLufs - pass1.integratedLufs;
  gainDb = Math.max(-18, Math.min(24, gainDb));

  // Reserve codec headroom and compensate lookahead to keep word timing anchored.
  let ceilingDb = -2.5;
  const applyMasterPass = (inWav, outWav, dbDelta) => {
    const ceiling = 10 ** (ceilingDb / 20);
    execFileSync(
      ffmpegBin,
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', inWav,
        '-af', `volume=${dbDelta.toFixed(3)}dB,aresample=192000,alimiter=limit=${ceiling.toFixed(6)}:attack=5:release=70:level=false:asc=true:latency=true,aresample=48000,apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}`,
        '-ar', '48000',
        '-ac', '2',
        '-c:a', 'pcm_s16le',
        outWav,
      ],
      { timeout: 60000 },
    );
  };

  let finalMetrics;
  let encodedPreviewMetrics;
  const previewPath = join(workDir, 'master-aac-preview.m4a');
  // AAC can create inter-sample overshoots well above the PCM peak. Verify the
  // intended delivery codec instead of assuming a fixed headroom guarantees it.
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      applyMasterPass(premasterWav, outputWavPath, gainDb);
      finalMetrics = measureAudioMetrics(outputWavPath, ffmpegBin, ffprobeBin);
      execFileSync(ffmpegBin, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outputWavPath, '-c:a', 'aac', '-b:a', '384k', previewPath], { timeout: 60000 });
      encodedPreviewMetrics = measureAudioMetrics(previewPath, ffmpegBin, ffprobeBin);
      const loudnessError = desiredLufs - finalMetrics.integratedLufs;
      const peakError = Math.max(0, encodedPreviewMetrics.truePeakDbtp + 1.2);
      if (Math.abs(loudnessError) <= 0.45 && peakError <= 0.05) break;
      if (attempt < 4) {
        ceilingDb = Math.max(-9, ceilingDb - peakError - (peakError > 0 ? 0.15 : 0));
        gainDb = Math.max(-18, Math.min(24, gainDb + loudnessError));
      }
    }
    if (encodedPreviewMetrics.truePeakDbtp > -1.0) {
      throw new Error(`AAC master true peak exceeds delivery ceiling: ${encodedPreviewMetrics.truePeakDbtp} dBTP`);
    }
  } finally {
    try { unlinkSync(previewPath); } catch { /* ignore */ }
  }

  try { unlinkSync(specPath); } catch { /* ignore */ }
  try { unlinkSync(premasterWav); } catch { /* ignore */ }
  try { unlinkSync(musicBus); } catch { /* ignore */ }
  try { unlinkSync(sfxBus); } catch { /* ignore */ }

  return {
    outputWavPath,
    vocalsBusPath: vocalsBus,
    metrics: finalMetrics,
    mastering: { targetLufs: desiredLufs, pcmCeilingDbtp: ceilingDb, limiterOversampling: 4, latencyCompensated: true, encodedPreviewMetrics, previewCodec: 'aac-384k' },
    busPeakDbfs: buses.busPeakDbfs,
  };
}

