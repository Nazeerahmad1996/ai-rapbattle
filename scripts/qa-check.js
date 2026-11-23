#!/usr/bin/env node
/**
 * Standalone QA Check CLI tool (`scripts/qa-check.js`).
 *
 * Runs the Automated Video Reviewer (sensor check + contact sheet generation) on a battle video:
 * Usage:
 *   node scripts/qa-check.js --id bad08f04
 *   node scripts/qa-check.js --video data/videos/bad08f04/battle-9x16-shorts.mp4 --manifest data/videos/bad08f04/manifest.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIDEOS_DIR, loadManifest } from '../server/automation.js';
import { reviewAndFixBattleVideo, runVideoSensorPass, generateIterationReportMarkdown, loadBaselineMetrics } from '../server/video-reviewer.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const opts = { maxReviews: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id' && argv[i + 1]) opts.id = argv[++i];
    else if (a === '--video' && argv[i + 1]) opts.video = argv[++i];
    else if (a === '--manifest' && argv[i + 1]) opts.manifest = argv[++i];
    else if (a === '--out-dir' && argv[i + 1]) opts.outDir = argv[++i];
    else if (a === '--skip-whisper') opts.skipWhisper = true;
    else if (a === '--max-reviews' && argv[i + 1]) opts.maxReviews = Number(argv[++i]);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.id) {
    console.error(`[qa-check] Running QA review loop for battle ${opts.id} (maxReviews: ${opts.maxReviews})...`);
    const res = await reviewAndFixBattleVideo({
      battleId: opts.id,
      skipWhisper: opts.skipWhisper,
      maxReviews: opts.maxReviews,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    process.exit(res.approvedForUpload ? 0 : 1);
  }

  if (opts.video && opts.manifest) {
    const outDir = opts.outDir || join(ROOT_DIR, 'qa', 'manual-check');
    const sensorReport = runVideoSensorPass({
      videoPath: opts.video,
      manifestPath: opts.manifest,
      outDir,
      skipWhisper: opts.skipWhisper,
    });
    const baseline = loadBaselineMetrics();
    const manifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
    const md = generateIterationReportMarkdown({
      iteration: 1,
      battleId: manifest.id || 'manual',
      aspect: opts.video.includes('9x16') ? '9:16' : '16:9',
      report: sensorReport,
      baseline,
    });
    console.error(md);
    process.stdout.write(JSON.stringify(sensorReport, null, 2) + '\n');
    process.exit(sensorReport.ok ? 0 : 1);
  }

  console.error('Usage: node scripts/qa-check.js --id <battleId> [--skip-whisper] [--max-reviews 4]');
  process.exit(1);
}

main().catch(err => {
  console.error('[qa-check-error]', err);
  process.exit(1);
});

