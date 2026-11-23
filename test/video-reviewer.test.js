import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewAndFixBattleVideo, buildReviewScript, canRepairAudio } from '../server/video-reviewer.js';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'botbrawl-review-'));
  const dir = join(root, 'videos', 'fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'fixture', timelineV2: { lines: [{ text: 'wide script' }] }, shortsTimelineV2: { lines: [{ text: 'short script' }] } }));
  for (const suffix of ['16x9', '9x16-shorts']) writeFileSync(join(dir, `battle-${suffix}.mp4`), 'original');
  return { root, dir, videosDir: join(root, 'videos') };
};

test('script uses the requested aspect and excludes words crossing a clipped ending', () => {
  const manifest = { timelineV2: { lines: [{ text: 'wide' }] }, shortsTimelineV2: { lines: [{ clipEndMs: 100, words: [{ text: 'spoken', startMs: 0, endMs: 80 }, { text: 'cut', startMs: 90, endMs: 150 }] }] } };
  assert.equal(buildReviewScript(manifest, '9:16'), 'spoken');
  assert.equal(buildReviewScript(manifest, '16:9'), 'wide');
});

test('one passing aspect cannot approve a failing second export', async () => {
  const f = fixture();
  const seen = [];
  const result = await reviewAndFixBattleVideo({ battleId: 'fixture', videosDir: f.videosDir, qaRoot: join(f.root, 'qa'), maxReviews: 4, sensorFn: options => { seen.push(options.aspect); return { ok: options.aspect === '9:16', checks: { export_valid: options.aspect === '9:16' } }; } });
  assert.deepEqual(seen, ['16:9', '9:16']);
  assert.equal(result.approvedForUpload, false);
  assert.equal(result.totalReviewsRun, 1, 'unchanged files are not reviewed repeatedly without a repair callback');
});

test('missing requested aspect fails closed', async () => {
  const f = fixture();
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(f.dir, 'battle-16x9.mp4'));
  const result = await reviewAndFixBattleVideo({ battleId: 'fixture', videosDir: f.videosDir, qaRoot: join(f.root, 'qa'), sensorFn: () => ({ ok: true, checks: { valid: true } }) });
  assert.equal(result.approvedForUpload, false);
  assert.equal(result.bestCandidate.aspects['16:9'].checks.rendered_file_exists, false);
});

test('failed later repair restores the better candidate files and matching manifest', async () => {
  const f = fixture();
  let generation = 1;
  const result = await reviewAndFixBattleVideo({ battleId: 'fixture', videosDir: f.videosDir, qaRoot: join(f.root, 'qa'), maxReviews: 2,
    sensorFn: () => ({ ok: false, checks: { first: generation === 1, second: false } }),
    renderFn: () => { generation++; writeFileSync(join(f.dir, 'battle-16x9.mp4'), 'worse'); const m = JSON.parse(readFileSync(join(f.dir, 'manifest.json'))); m.changed = true; writeFileSync(join(f.dir, 'manifest.json'), JSON.stringify(m)); },
  });
  assert.equal(result.bestCandidate.attempt, 1);
  assert.equal(readFileSync(join(f.dir, 'battle-16x9.mp4'), 'utf8'), 'original');
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'manifest.json'))).changed, undefined);
});

test('default audio repair only runs for measured and repairable defects', () => {
  const reports = { '16:9': { checks: { target_lufs_met: false, true_peak_safe: true }, metrics: { ebur128: { integratedLufs: -16 } } } };
  assert.equal(canRepairAudio(reports), true);
  reports['16:9'].checks.zero_safe_zone_violations = false;
  assert.equal(canRepairAudio(reports), false);
  delete reports['16:9'].checks.zero_safe_zone_violations;
  reports['16:9'].checks.true_peak_safe = false;
  assert.equal(canRepairAudio(reports), false);
  const skipped = { '9:16': { checks: { final_mix_intelligibility_ge_95: false }, metrics: { whisperIntelligibility: { ok: false, skipped: true } } } };
  assert.equal(canRepairAudio(skipped, { skipWhisper: true }), false);
});
