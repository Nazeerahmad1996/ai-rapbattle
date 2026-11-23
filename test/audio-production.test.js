import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProsody, trimWordTimings } from '../server/tts.js';
import { mixMasterBattleAudio, measureAudioMetrics } from '../server/audio-mixer.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = join(root, '.venv-studio/bin/python');
const studioAvailable = existsSync(python);

test('speech trimming moves boundaries and removes words outside the retained window', () => {
  const words = [
    { text: 'discard', offsetMs: 0, durationMs: 40 },
    { text: 'first', offsetMs: 100, durationMs: 200 },
    { text: 'last', offsetMs: 350, durationMs: 300 },
  ];
  assert.deepEqual(trimWordTimings(words, 120, 500), [
    { text: 'first', offsetMs: 0, durationMs: 180 },
    { text: 'last', offsetMs: 230, durationMs: 150 },
  ]);
});

test('speech modes preserve distinct conversational, rap, and poetry rates', () => {
  const rate = mode => Number.parseFloat(getProsody({ mode }).rate);
  assert.ok(rate('poetry') < rate('story'));
  assert.ok(rate('story') < rate('roast'));
  assert.ok(rate('roast') < rate('rap'));
  assert.notEqual(getProsody({ mode: 'rap', role: 'a' }).pitch, getProsody({ mode: 'rap', role: 'b' }).pitch);
});

test('studio buses preserve overlapping peaks, reject absent stems, and support long rap cells', { skip: !studioAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'botbrawl-buses-test-'));
  try {
    const result = execFileSync(python, ['-c', `
import json, sys, subprocess
from pathlib import Path
import numpy as np
import soundfile as sf
from scripts.local_tts import fit_rap_line_to_bars, pick_kokoro_profile, export_audio_file
out = Path(sys.argv[1])
source = out / 'tone.wav'
sr = 48000
sf.write(source, np.full(sr, 0.8, dtype=np.float32), sr, subtype='FLOAT')
lines = [dict(id=str(i), audioPath=str(source), startMs=0, endMs=1000) for i in range(2)]
spec = out / 'spec.json'
spec.write_text(json.dumps(dict(timelineV2=dict(totalDurationMs=1000, mode='rap', lines=lines, beatGrid=dict(offsetMs=5000)), outDir=str(out), beat=True)))
subprocess.run([sys.executable, 'scripts/mix_buses.py', '--spec', str(spec)], check=True, capture_output=True)
bus, rate = sf.read(out / 'vocals-bus.wav')
assert sf.info(out / 'vocals-bus.wav').subtype == 'FLOAT'
assert np.max(np.abs(bus)) > 1.5
assert rate == sr and len(bus) == sr and bus.shape[1] == 2
data = json.loads(spec.read_text()); data['timelineV2']['lines'][0]['audioPath'] = '/missing/stem.wav'
spec.write_text(json.dumps(data))
assert subprocess.run([sys.executable, 'scripts/mix_buses.py', '--spec', str(spec)], capture_output=True).returncode != 0
samples = np.full(24000 * 13, 0.1, dtype=np.float32)
class NeverRegenerate:
 def create(self, *args, **kwargs): raise AssertionError('long lines must not be forced into short cells')
audio, meta = fit_rap_line_to_bars(NeverRegenerate(), 'long line', {'speed': 1.0}, samples, 24000, bpm=90)
assert meta['bars'] == 5 and meta['fitted'] and len(audio) == len(samples)
for lang in ['English', 'Hindi', 'Spanish']:
 rap = pick_kokoro_profile(lang, 'a', mode='rap')
 poetry = pick_kokoro_profile(lang, 'a', mode='poetry')
 assert poetry['speed'] < rap['speed'] and poetry['clause_pause'] > rap['clause_pause']
assert pick_kokoro_profile('English-GB', 'a')['lang'] in ['en-gb', 'en-us']
try: export_audio_file(np.zeros(1000), 24000, str(out / 'silence.wav'))
except ValueError: pass
else: raise AssertionError('silent synthesis must fail')
print('ok')
`, dir], { cwd: root, encoding: 'utf8' });
    assert.equal(result.trim(), 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('master remains sample-locked and verifies the encoded AAC delivery', { skip: !studioAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'botbrawl-master-test-'));
  try {
    const stem = join(dir, 'tone.wav');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'pcm_f32le', stem]);
    const mixed = mixMasterBattleAudio({
      timelineV2: { mode: 'poetry', totalDurationMs: 2345, lines: [{ id: 'tone', role: 'a', audioPath: stem, startMs: 100, endMs: 2100 }] },
      workDir: dir, outputWavPath: join(dir, 'master.wav'), beat: false,
    });
    assert.equal(mixed.metrics.durationSec, 2.345);
    assert.equal(mixed.metrics.sampleRateHz, 48000);
    assert.equal(mixed.metrics.channels, 2);
    assert.equal(mixed.mastering.latencyCompensated, true);
    const onsetMs = Number(execFileSync(python, ['-c', 'import sys,numpy as np,soundfile as sf; a,sr=sf.read(sys.argv[1]); active=np.flatnonzero(np.max(np.abs(a),axis=1)>0.0001); print(active[0]*1000/sr)', mixed.outputWavPath], { encoding: 'utf8' }).trim());
    assert.ok(Math.abs(onsetMs - 100) <= 1, `limiter shifted the audible onset to ${onsetMs} ms`);
    assert.ok(mixed.mastering.encodedPreviewMetrics.truePeakDbtp <= -1);
    assert.ok(Math.abs(mixed.metrics.integratedLufs + 14) <= 0.5);
    const invalid = join(dir, 'invalid.wav');
    writeFileSync(invalid, 'not audio');
    assert.throws(() => measureAudioMetrics(invalid));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
