#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIDEOS_DIR,
  produceAutomatedBattle,
  upgradeBattleToV2,
  loadManifest,
  getCapabilities,
  runDoctorCheck,
} from '../server/automation.js';
import { renderBattleVideos, getChromeExecutablePath } from '../server/video-renderer.js';
import { reviewAndFixBattleVideo } from '../server/video-reviewer.js';
import { requestedDeliveryFiles, mayUploadAspect } from '../server/delivery-policy.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function parseArgs(argv) {
  const opts = { aspects: ['16:9', '9:16'], renderVideo: true, beat: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--no-video') opts.renderVideo = false;
    else if (a === '--no-beat') opts.beat = false;
    else if (a === '--full-shorts') opts.fullShorts = true;
    else if (a === '--shorts-only') opts.aspects = ['9:16'];
    else if (a === '--widescreen-only') opts.aspects = ['16:9'];
    else if (a === '--upload') opts.upload = true;
    else if (a === '--doctor') opts.doctorOnly = true;
    else if (a === '--capabilities' || a === '--help' || a === '-h') opts.capabilitiesOnly = true;
    else if (a === '--mode' && argv[i + 1]) opts.mode = argv[++i];
    else if (a === '--language' && argv[i + 1]) opts.language = argv[++i];
    else if (a === '--topic' && argv[i + 1]) opts.topic = argv[++i];
    else if (a === '--rounds' && argv[i + 1]) opts.rounds = Number(argv[++i]);
    else if (a === '--lines' && argv[i + 1]) opts.lines = Number(argv[++i]);
    else if (a === '--a' && argv[i + 1]) opts.a = argv[++i];
    else if (a === '--a-model' && argv[i + 1]) opts.aModel = argv[++i];
    else if (a === '--b' && argv[i + 1]) opts.b = argv[++i];
    else if (a === '--b-model' && argv[i + 1]) opts.bModel = argv[++i];
    else if (a === '--judge' && argv[i + 1]) opts.judge = argv[++i];
    else if (a === '--judge-model' && argv[i + 1]) opts.judgeModel = argv[++i];
    else if (a === '--id' && argv[i + 1]) opts.existingId = argv[++i];
    else if (a === '--aspect' && argv[i + 1]) opts.aspects = [argv[++i]];
    else if (a === '--preview') opts.preview = true;
    else if (a === '--no-review') opts.review = false;
    else if (a === '--no-clean' || a === '--spicy' || a === '--explicit') opts.clean = false;
    else if (a === '--skip-whisper') opts.skipWhisper = true;
    else if (a === '--upgrade-v2') opts.upgradeV2 = true;
  }
  return opts;
}

async function isServerUp() {
  try {
    const r = await fetch(`${BASE_URL}/api/modes`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Auto-start the BotBrawl server in the background if not already running. */
async function ensureServer() {
  if (await isServerUp()) return { stop: () => {} };
  console.error('[grokbot] Starting BotBrawl server in background...');
  const child = spawn(process.execPath, [join(ROOT_DIR, 'server', 'index.js')], {
    cwd: ROOT_DIR,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT) },
  });
  for (let attempt = 0; attempt < 25; attempt++) {
    await new Promise(r => setTimeout(r, 250));
    if (await isServerUp()) {
      return { stop: () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } } };
    }
  }
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  throw new Error('Timed out waiting for local BotBrawl server to start.');
}

/** Optional direct YouTube Data API v3 uploader + custom VS Poster thumbnail attachment. */
async function uploadVideoToYouTube({
  videoPath,
  thumbnailPath = null,
  title,
  description,
  tags,
  privacyStatus = 'public',
}) {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return {
      uploaded: false,
      reason: 'Missing YouTube OAuth credentials in .env. Run `npm run youtube-login` once to connect your YouTube channel in your normal browser.',
    };
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(`YouTube OAuth token refresh failed: ${JSON.stringify(tokenData)}`);
  }

  const videoBytes = readFileSync(videoPath);
  const metadata = {
    snippet: {
      title,
      description,
      tags,
      categoryId: '24', // Entertainment
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(videoBytes.length),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!initRes.ok) {
    throw new Error(`YouTube resumable init failed (${initRes.status}): ${await initRes.text()}`);
  }
  const uploadUrl = initRes.headers.get('location');
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(videoBytes.length),
    },
    body: videoBytes,
  });
  const uploaded = await putRes.json();
  if (!putRes.ok) {
    throw new Error(`YouTube video upload failed (${putRes.status}): ${JSON.stringify(uploaded)}`);
  }

  let thumbnailUploaded = false;
  let thumbnailNote = null;
  if (thumbnailPath && existsSync(thumbnailPath)) {
    try {
      const thumbBytes = readFileSync(thumbnailPath);
      const thumbRes = await fetch(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(uploaded.id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'Content-Type': 'image/png',
            'Content-Length': String(thumbBytes.length),
          },
          body: thumbBytes,
        },
      );
      thumbnailUploaded = thumbRes.ok;
      if (!thumbRes.ok) {
        thumbnailNote = `Custom thumbnail skipped (${thumbRes.status}); video itself is live.`;
      }
    } catch (e) {
      thumbnailNote = `Custom thumbnail skipped (${e.message}); video itself is live.`;
    }
  }

  return {
    uploaded: true,
    videoId: uploaded.id,
    url: `https://www.youtube.com/watch?v=${uploaded.id}`,
    thumbnailUploaded,
    ...(thumbnailNote ? { thumbnailNote } : {}),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.doctorOnly) {
    const report = runDoctorCheck(getChromeExecutablePath());
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(report.ok ? 0 : 1);
  }
  if (opts.capabilitiesOnly) {
    process.stdout.write(JSON.stringify({ ok: true, data: getCapabilities() }, null, 2) + '\n');
    return;
  }

  mkdirSync(VIDEOS_DIR, { recursive: true });
  const todayKey = new Date().toISOString().slice(0, 10);
  const dailyCacheFile = join(VIDEOS_DIR, `daily-${todayKey}.json`);
  const hasCustomOverrides = Boolean(
    opts.mode || opts.topic || opts.language || opts.existingId || opts.a || opts.b || opts.aModel || opts.bModel,
  );

  const wantUpload = Boolean(opts.upload || process.env.YOUTUBE_AUTO_UPLOAD === '1');
  let reusedDailyCache = false;

  // Daily Idempotency: return cached output if already produced today unless --force or custom flags are passed
  if (!opts.force && !hasCustomOverrides && existsSync(dailyCacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(dailyCacheFile, 'utf8'));
      const alreadyUploaded = Boolean(
        cached?.youtubeUploads?.main16x9?.uploaded && cached?.youtubeUploads?.shorts9x16?.uploaded,
      );
      if (cached?.files?.video16x9 && existsSync(cached.files.video16x9)) {
        if (!wantUpload || alreadyUploaded) {
          console.error(`[grokbot] Returning cached daily production for ${todayKey} (use --force to regenerate).`);
          process.stdout.write(JSON.stringify({ ...cached, cached: true }, null, 2) + '\n');
          return;
        }
        // Videos were already rendered today without uploading; reuse battleId to upload them now
        opts.existingId = cached.battleId;
        reusedDailyCache = true;
      }
    } catch { /* regenerate if cache invalid */ }
  }

  const existingManifest = opts.existingId ? loadManifest(opts.existingId) : null;
  if (opts.existingId && !existingManifest) {
    throw new Error(`Battle manifest not found for id: ${opts.existingId}`);
  }

  let preRendered = null;
  if (existingManifest && !opts.force) {
    const outDir = join(VIDEOS_DIR, existingManifest.id);
    const candidate = {
      ...(existsSync(join(outDir, 'battle-16x9.mp4')) ? { video16x9: join(outDir, 'battle-16x9.mp4') } : {}),
      ...(existsSync(join(outDir, 'battle-9x16-shorts.mp4')) ? { video9x16Shorts: join(outDir, 'battle-9x16-shorts.mp4') } : {}),
      ...(existsSync(join(outDir, 'thumbnail-16x9.png')) ? { thumbnail16x9: join(outDir, 'thumbnail-16x9.png') } : {}),
      ...(existsSync(join(outDir, 'thumbnail-9x16.png')) ? { thumbnail9x16: join(outDir, 'thumbnail-9x16.png') } : {}),
      ...(existsSync(join(outDir, 'backing-bed.wav')) ? { backingAudioWav: join(outDir, 'backing-bed.wav') } : {}),
    };
    const hasAllRequested =
      (!opts.aspects.includes('16:9') || Boolean(candidate.video16x9)) &&
      (!opts.aspects.includes('9:16') || Boolean(candidate.video9x16Shorts));
    if (hasAllRequested) preRendered = requestedDeliveryFiles(candidate, opts.aspects);
  }

  const needsServer = !existingManifest || (opts.renderVideo && (!preRendered || opts.upgradeV2 || !existingManifest?.timelineV2 || opts.review !== false));
  const srv = needsServer ? await ensureServer() : { stop: () => {} };
  try {
    let manifest = existingManifest;
    if (!manifest) {
      console.error('[grokbot] 1/3 Producing battle & parallel neural voice stems...');
      manifest = await produceAutomatedBattle(opts);
    } else if (opts.upgradeV2 || !manifest.timelineV2) {
      console.error(`[grokbot] 1/3 Upgrading existing battle ${manifest.id} to V2 motion & audio pipeline...`);
      manifest = await upgradeBattleToV2(manifest.id, opts);
      preRendered = null;
    } else {
      console.error(`[grokbot] 1/3 Loaded existing battle manifest ${manifest.id}...`);
    }

    let files = {
      manifestJson: join(VIDEOS_DIR, manifest.id, 'manifest.json'),
      metadataJson: join(VIDEOS_DIR, manifest.id, 'youtube-metadata.json'),
    };

    if (opts.renderVideo) {
      if (preRendered && !opts.force) {
        console.error(`[grokbot] 2/3 Reusing existing rendered MP4s & VS posters for ${manifest.id}...`);
        files = { ...files, ...preRendered };
      } else {
        console.error(`[grokbot] 2/3 Rendering parallel headless videos & VS posters (${opts.aspects.join(', ')})...`);
        const rendered = await renderBattleVideos({
          idOrManifest: manifest,
          baseUrl: BASE_URL,
          aspects: opts.aspects,
          preview: Boolean(opts.preview),
          overrides: opts.overrides || {},
        });
        files = { ...files, ...requestedDeliveryFiles(rendered, opts.aspects) };
      }
    }

    let reviewOutcome = null;
    if (opts.renderVideo && opts.review !== false && !opts.preview) {
      console.error('[grokbot] Running Automated Video Reviewer (max 4 reviews before decision)...');
      reviewOutcome = await reviewAndFixBattleVideo({
        battleId: manifest.id,
        skipWhisper: Boolean(opts.skipWhisper),
        aspects: opts.aspects,
        baseUrl: BASE_URL,
        beat: opts.beat !== false,
        maxReviews: 4,
      });
      files.reviewJson = join(VIDEOS_DIR, manifest.id, 'review.json');
    }

    let youtubeUploads = null;
    if (wantUpload) {
      if (!reviewOutcome?.approvedForUpload) {
        console.error('[grokbot-warning] Automated review did not approve the finished files. Skipping upload; --force only regenerates content.');
      } else {
        console.error('[grokbot] 3/3 Uploading rendered videos & thumbnails to YouTube...');
        youtubeUploads = {};
        if (opts.aspects.includes('16:9') && mayUploadAspect(reviewOutcome, '16:9') && files.video16x9 && existsSync(files.video16x9)) {
          youtubeUploads.main16x9 = await uploadVideoToYouTube({
            videoPath: files.video16x9,
            thumbnailPath: files.thumbnail16x9,
            title: manifest.youtube.title,
            description: manifest.youtube.description,
            tags: manifest.youtube.tags,
          });
        }
        if (opts.aspects.includes('9:16') && mayUploadAspect(reviewOutcome, '9:16') && files.video9x16Shorts && existsSync(files.video9x16Shorts)) {
          youtubeUploads.shorts9x16 = await uploadVideoToYouTube({
            videoPath: files.video9x16Shorts,
            thumbnailPath: files.thumbnail9x16,
            title: manifest.youtube.shortsTitle,
            description: manifest.youtube.description,
            tags: manifest.youtube.tags,
          });
        }
      }
    }

    const fileStats = {};
    for (const [k, p] of Object.entries(files)) {
      if (typeof p === 'string' && p && existsSync(p)) fileStats[k] = { path: p, sizeBytes: statSync(p).size };
    }

    const output = {
      ok: true,
      date: todayKey,
      battleId: manifest.id,
      battle: manifest.battle,
      totalDurationMs: manifest.totalDurationMs,
      shortsDurationMs: manifest.shortsDurationMs || manifest.totalDurationMs,
      files,
      fileStats,
      youtube: manifest.youtube,
      review: reviewOutcome,
      youtubeUploads,
      next_actions: [
        {
          command: `npm run grokbot -- --id ${manifest.id} --upload`,
          description: 'Upload the rendered 16:9 and 9:16 MP4 videos + VS Poster thumbnails to YouTube (requires YOUTUBE_* env vars)',
        },
      ],
    };

    if (!hasCustomOverrides || reusedDailyCache) {
      writeFileSync(dailyCacheFile, JSON.stringify(output, null, 2));
    }
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } finally {
    srv.stop();
  }
}

main().catch(err => {
  const cap = getCapabilities();
  const payload = {
    ok: false,
    error: {
      code: 'GROKBOT_PIPELINE_ERROR',
      message: err.message,
      valid_modes: cap.modes.map(m => m.id),
      valid_languages: cap.languages,
      suggested_fix: 'Run `npm run grokbot -- --doctor` to verify prerequisites, or `npm run grokbot -- --force` to let Auto-Director pick automatically.',
    },
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(1);
});
