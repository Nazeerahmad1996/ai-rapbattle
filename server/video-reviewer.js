/** Review measured exports; preserve the media and manifest for the best candidate. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIDEOS_DIR, getFfmpegBin, getFfprobeBin } from './automation.js';
import { STUDIO_PYTHON } from './forced-aligner.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const QA_SENSOR_SCRIPT = join(ROOT_DIR, 'scripts', 'qa_review_sensor.py');
export const MAX_REVIEWS = 4;
const ASPECT_SUFFIX = { '16:9': '16x9', '9:16': '9x16-shorts' };

export function loadBaselineMetrics() {
  try { return JSON.parse(readFileSync(join(ROOT_DIR, 'qa', 'baseline', 'metrics.json'), 'utf8')); }
  catch { return {}; }
}

export function buildReviewScript(manifest, aspect) {
  const tl = aspect === '9:16' ? manifest.shortsTimelineV2 || manifest.timelineV2 : manifest.timelineV2;
  return (tl?.lines || []).map(line => {
    if (line.clipEndMs != null && line.words?.length) {
      return line.words.filter(word => word.endMs <= line.clipEndMs).map(word => word.text).join(' ');
    }
    return line.text || '';
  }).filter(Boolean).join(' ');
}

export function runVideoSensorPass({ videoPath, manifestPath, outDir, scriptText = '', skipWhisper = false, aspect }) {
  mkdirSync(outDir, { recursive: true });
  const args = [QA_SENSOR_SCRIPT, '--video', videoPath, '--manifest', manifestPath, '--out-dir', outDir];
  if (aspect) args.push('--aspect', aspect);
  if (skipWhisper) args.push('--skip-whisper');
  if (scriptText) {
    const path = join(outDir, 'script.txt');
    writeFileSync(path, scriptText, 'utf8');
    args.push('--script', path);
  }
  const stdout = execFileSync(STUDIO_PYTHON, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

export function generateIterationReportMarkdown({ iteration, battleId, aspect, report, overridesApplied = {} }) {
  const rows = Object.entries(report.checks || {}).map(([key, passed]) => `| ${key} | ${passed === true ? 'PASS' : 'FAIL / unavailable'} |`).join('\n');
  return `# BotBrawl export review\n\nBattle: ${battleId}. Aspect: ${aspect}. Attempt: ${iteration}.\n\nDecision: **${report.ok ? 'Measured checks passed' : 'Not approved'}**.\n\n| Check | Result |\n| --- | --- |\n${rows}\n\n## Measured metrics\n\n\`\`\`json\n${JSON.stringify(report.metrics || {}, null, 2)}\n\`\`\`\n\n## Limits\n\nCaption lead values validate the planned schedule against source alignment; they do not independently measure acoustic synchronization in the exported mix. Contact sheets are diagnostic artifacts, not an automated aesthetic review. Skipped or failed mandatory measurements cannot approve an export.\n\n## Applied settings\n\n\`\`\`json\n${JSON.stringify(overridesApplied, null, 2)}\n\`\`\`\n`;
}

function failedReport(error, check = 'sensor_completed') {
  return { ok: false, checks: { [check]: false }, metrics: {}, error: String(error) };
}

function snapshotCandidate(videoDir, destination) {
  mkdirSync(destination, { recursive: true });
  const names = readdirSync(videoDir).filter(name => statSync(join(videoDir, name)).isFile() && /\.(?:mp4|png|wav|json)$/.test(name) && name !== 'review.json');
  for (const name of names) copyFileSync(join(videoDir, name), join(destination, name));
  return names;
}

function rankCandidate(candidate) {
  return Object.values(candidate.aspects).reduce((sum, report) => sum + Object.values(report.checks || {}).filter(value => value === true).length, 0);
}

export function canRepairAudio(reports, { skipWhisper = false } = {}) {
  const failed = Object.values(reports).flatMap(report => Object.entries(report.checks || {}).filter(([, passed]) => passed !== true).map(([key]) => ({ key, report })));
  return failed.length > 0 && failed.every(({ key, report }) => {
    if (key === 'target_lufs_met') return Number.isFinite(report.metrics?.ebur128?.integratedLufs) && !report.metrics?.ebur128?.error;
    if (key === 'final_mix_intelligibility_ge_95') return !skipWhisper && report.metrics?.whisperIntelligibility?.ok === true && !report.metrics?.whisperIntelligibility?.skipped && Number.isFinite(report.metrics?.whisperIntelligibility?.wordMatchPct);
    return false;
  });
}

async function repairBattleFromExistingStems({ videoDir, aspects, overrides, baseUrl, beat }) {
  const manifestPath = join(videoDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const [{ mixMasterBattleAudio }, { renderBattleVideos }] = await Promise.all([import('./audio-mixer.js'), import('./video-renderer.js')]);
  for (const aspect of aspects) {
    const timelineV2 = aspect === '9:16' ? manifest.shortsTimelineV2 || manifest.timelineV2 : manifest.timelineV2;
    if (!timelineV2?.lines?.length || timelineV2.lines.some(line => !line.audioPath || !existsSync(line.audioPath))) throw new Error('Cannot repair audio: existing source stems are missing');
    const outputWavPath = join(videoDir, aspect === '9:16' ? 'master-audio-9x16.wav' : 'master-audio-16x9.wav');
    mixMasterBattleAudio({ timelineV2, workDir: join(videoDir, `tmp-repair-${aspect.replace(':', 'x')}`), outputWavPath,
      ffmpegBin: getFfmpegBin(), ffprobeBin: getFfprobeBin(), beat,
      masterGainTrimDb: overrides.masterGainTrimDb, sidechainRatio: overrides.sidechainRatio });
    manifest[aspect === '9:16' ? 'audio9x16' : 'audio16x9'] = outputWavPath;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await renderBattleVideos({ idOrManifest: manifest, baseUrl, aspects, overrides });
}

export async function reviewAndFixBattleVideo({ battleId, renderFn, skipWhisper = false, maxReviews = MAX_REVIEWS,
  aspects = ['16:9', '9:16'], videosDir = VIDEOS_DIR, qaRoot = join(ROOT_DIR, 'qa'), sensorFn = runVideoSensorPass,
  baseUrl = 'http://127.0.0.1:3000', beat = true, autoRepair = true }) {
  if (!aspects.length || aspects.some(aspect => !ASPECT_SUFFIX[aspect])) throw new Error('At least one valid requested aspect is required');
  const requestedAspects = [...new Set(aspects)];
  const videoDir = join(videosDir, battleId);
  const manifestPath = join(videoDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Manifest not found for battle ${battleId}`);
  const limit = Math.min(MAX_REVIEWS, Math.max(1, Math.floor(Number(maxReviews) || 1)));
  const currentOverrides = { captionFontScale: 1, masterGainTrimDb: 0, sidechainRatio: 4.5 };
  const battleQaRoot = join(qaRoot, battleId);
  mkdirSync(battleQaRoot, { recursive: true });
  const runDir = mkdtempSync(join(battleQaRoot, 'run-'));
  let bestCandidate = null;
  const history = [];
  for (let attempt = 1; attempt <= limit; attempt++) {
    const iterDir = join(runDir, `iter-${attempt}`);
    mkdirSync(iterDir, { recursive: true });
    if (attempt > 1) {
      try {
        if (renderFn) await renderFn({ overrides: currentOverrides, attempt });
        else await repairBattleFromExistingStems({ videoDir, aspects: requestedAspects, overrides: currentOverrides, baseUrl, beat });
      }
      catch (error) { history.push({ attempt, ok: false, repairError: String(error), aspects: {} }); break; }
    }
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (error) { history.push({ attempt, ok: false, repairError: `Invalid candidate manifest: ${error}`, aspects: {} }); break; }
    const reports = {};
    for (const aspect of requestedAspects) {
      const videoPath = join(videoDir, `battle-${ASPECT_SUFFIX[aspect]}.mp4`);
      const outDir = join(iterDir, aspect.replace(':', 'x'));
      mkdirSync(outDir, { recursive: true });
      try {
        reports[aspect] = existsSync(videoPath)
          ? await sensorFn({ videoPath, manifestPath, outDir, scriptText: buildReviewScript(manifest, aspect), skipWhisper, aspect })
          : failedReport(`Missing requested export: ${videoPath}`, 'rendered_file_exists');
      } catch (error) { reports[aspect] = failedReport(error); }
      if (!reports[aspect] || typeof reports[aspect] !== 'object') reports[aspect] = failedReport('Sensor returned no report');
      const checks = Object.values(reports[aspect].checks || {});
      reports[aspect].ok = reports[aspect].ok === true && checks.length > 0 && checks.every(value => value === true);
      writeFileSync(join(outDir, 'report.md'), generateIterationReportMarkdown({ iteration: attempt, battleId, aspect, report: reports[aspect], overridesApplied: currentOverrides }));
    }
    const entry = { attempt, ok: requestedAspects.every(aspect => reports[aspect].ok), aspects: reports, overrides: { ...currentOverrides }, reportPath: iterDir };
    entry.metrics = reports[requestedAspects[0]]?.metrics || {};
    entry.checks = Object.fromEntries(requestedAspects.flatMap(aspect => Object.entries(reports[aspect].checks || {}).map(([key, value]) => [`${aspect}:${key}`, value])));
    history.push(entry);
    if (!bestCandidate || (entry.ok && !bestCandidate.ok) || (!bestCandidate.ok && rankCandidate(entry) > rankCandidate(bestCandidate))) {
      entry.snapshotDir = join(iterDir, 'candidate');
      entry.snapshotFiles = snapshotCandidate(videoDir, entry.snapshotDir);
      bestCandidate = entry;
    }
    if (entry.ok || (typeof renderFn !== 'function' && (!autoRepair || !canRepairAudio(reports, { skipWhisper })))) break;
    const failedLoudness = Object.values(reports).filter(report => report.checks.target_lufs_met === false && Number.isFinite(report.metrics?.ebur128?.integratedLufs));
    if (failedLoudness.length) currentOverrides.masterGainTrimDb += failedLoudness.reduce((sum, report) => sum - 14 - report.metrics.ebur128.integratedLufs, 0) / failedLoudness.length * .9;
    if (Object.values(reports).some(report => report.checks.final_mix_intelligibility_ge_95 === false)) currentOverrides.sidechainRatio = Math.min(8, currentOverrides.sidechainRatio + 1.2);
  }
  if (bestCandidate) {
    for (const name of bestCandidate.snapshotFiles) copyFileSync(join(bestCandidate.snapshotDir, name), join(videoDir, name));
    for (const aspect of requestedAspects) {
      const sourceDir = join(bestCandidate.reportPath, aspect.replace(':', 'x'));
      const targetDir = join(videoDir, 'qa', aspect.replace(':', 'x'));
      mkdirSync(targetDir, { recursive: true });
      for (const name of readdirSync(sourceDir)) if (statSync(join(sourceDir, name)).isFile()) copyFileSync(join(sourceDir, name), join(targetDir, name));
    }
  }
  const result = { battleId, requestedAspects, approvedForUpload: Boolean(bestCandidate?.ok), totalReviewsRun: history.length, maxReviewsAllowed: limit, bestCandidate, history };
  writeFileSync(join(videoDir, 'review.json'), JSON.stringify(result, null, 2));
  return result;
}
