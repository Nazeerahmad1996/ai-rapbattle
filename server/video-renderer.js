import { existsSync, mkdirSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { VIDEOS_DIR, getFfmpegBin, loadManifest } from './automation.js';

const CHROME_PATHS = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

export function getChromeExecutablePath() {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export async function launchStudioBrowser(executablePath) {
  return chromium.launch({
    executablePath: executablePath || getChromeExecutablePath(),
    headless: true,
    args: [
      '--mute-audio',
      '--disable-gpu-vsync',
      '--font-render-hinting=none',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
}

/**
 * Render a single aspect ratio ('16:9' or '9:16') deterministically frame-by-frame
 * into an H.264 + AAC MP4 (`30.000 fps` CFR, zero lead-in desync) using `director.html`.
 */
export async function renderAspectVideo({
  manifest,
  baseUrl = 'http://127.0.0.1:3000',
  aspect = '9:16',
  preview = false,
  debugSafeZones = false,
  overrides = {},
  browser: sharedBrowser = null,
  onProgress = null,
}) {
  const ffmpeg = getFfmpegBin();
  if (!ffmpeg) throw new Error('ffmpeg binary not found in path');
  const executablePath = getChromeExecutablePath();
  if (!executablePath) throw new Error('Chrome/Brave executable not found in /Applications');

  const isShorts = aspect === '9:16';
  const baseWidth = isShorts ? 1080 : 1920;
  const baseHeight = isShorts ? 1920 : 1080;
  const scale = preview ? 0.5 : 1.0;
  const width = Math.round(baseWidth * scale);
  const height = Math.round(baseHeight * scale);

  const videoSuffix = isShorts ? '9x16-shorts' : '16x9';
  const thumbSuffix = isShorts ? '9x16' : '16x9';

  const outDir = join(VIDEOS_DIR, manifest.id);
  mkdirSync(outDir, { recursive: true });

  const outputMp4 = join(outDir, preview ? `preview-${videoSuffix}.mp4` : `battle-${videoSuffix}.mp4`);
  const thumbPng = join(outDir, `${preview ? 'preview-' : ''}thumbnail-${thumbSuffix}.png`);
  const tempMp4 = outputMp4.replace(/\.mp4$/, `.rendering-${process.pid}.mp4`);

  const activeTimeline =
    isShorts && manifest.shortsTimelineV2
      ? manifest.shortsTimelineV2
      : manifest.timelineV2 || manifest.timeline;

  if (!activeTimeline?.edition || !activeTimeline?.lines?.length) {
    throw new Error(`No valid timeline found in manifest for aspect ${aspect}`);
  }

  const fps = activeTimeline.fps || 30;
  const totalFrames =
    activeTimeline.totalFrames || Math.ceil((activeTimeline.totalDurationMs / 1000) * fps);
  const activeDurationMs = activeTimeline.totalDurationMs;

  const masterAudioPath =
    isShorts && manifest.audio9x16
      ? manifest.audio9x16
      : manifest.audio16x9 || manifest.masterAudioPath || join(outDir, 'master-audio.wav');

  if (!masterAudioPath || !existsSync(masterAudioPath)) throw new Error('Master audio missing: refusing a silent production export');
  const ownBrowser = !sharedBrowser;
  let ffmpegProc = null;
  let renderComplete = false;
  const browser = sharedBrowser || (await launchStudioBrowser(executablePath));

  const context = await browser.newContext({
    viewport: { width: baseWidth, height: baseHeight },
    deviceScaleFactor: 1,
  });

  const telemetrySamples = [];

  try {
    const page = await context.newPage();
    const url = `${baseUrl}/director.html?aspect=${encodeURIComponent(aspect)}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForFunction(() => typeof window.__initDirectorStage === 'function', null, { timeout: 15000 });
    await page.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 15000 });

    // Initialize director stage with master manifest & runtime overrides
    await page.evaluate(
      ({ m, asp, ovr }) => window.__initDirectorStage(m, asp, ovr),
      { m: manifest, asp: aspect, ovr: { debugSafeZones, ...overrides } },
    );

    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(img => img.decode()));
      if (!document.fonts.check('800 76px "Barlow Condensed"')) throw new Error('Broadcast font unavailable');
    });

    // 1. Capture dedicated non-spoiler VS Poster Thumbnail at the peak of the VS clash
    const vsEv = activeTimeline.events?.find(e => e.type === 'vs-slam');
    const vsPeakMs = vsEv ? vsEv.startMs + 650 : 2000;
    const vsPeakFrame = Math.round((vsPeakMs / 1000) * fps);
    await page.evaluate(f => window.__renderAtFrame(f), vsPeakFrame);
    await page.screenshot({ path: thumbPng, type: 'png' });

    // 2. Identify keyframes to sample layout telemetry during frame stepping
    const telemetryFrames = new Set([
      0,
      Math.round(fps * 0.5),
      vsPeakFrame,
      Math.round((activeDurationMs * 0.5 * 0.001) * fps),
      Math.max(0, totalFrames - Math.round(fps * 2.5)),
    ]);
    for (const ev of activeTimeline.events || []) {
      if (['punchline', 'speaker-switch', 'round-start', 'vote-cta', 'verdict'].includes(ev.type)) {
        telemetryFrames.add(Math.round((ev.startMs / 1000) * fps));
      }
    }

    for (const p of activeTimeline.captionPages || []) {
      telemetryFrames.add(p.startFrame + Math.min(3, Math.max(0, p.endFrame - p.startFrame - 1)));
    }
    for (const ev of activeTimeline.events || []) {
      if (['vs-slam', 'verdict', 'vote-cta', 'speaker-switch'].includes(ev.type)) {
        for (const dt of [200, 400, 650]) telemetryFrames.add(Math.round((ev.startMs + dt) * fps / 1000));
      }
    }

    // 3. Spawn FFmpeg child process with image2pipe
    const ffmpegArgs = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-framerate', String(fps),
      '-f', 'image2pipe',
      '-i', '-',
    ];

    const hasAudio = masterAudioPath && existsSync(masterAudioPath);
    if (hasAudio) {
      ffmpegArgs.push('-i', masterAudioPath);
    }

    ffmpegArgs.push('-vf', `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1`);

    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', preview ? 'ultrafast' : 'medium',
      '-crf', preview ? '26' : '17',
      '-profile:v', 'high', '-g', String(Math.round(fps / 2)), '-bf', '2',
      '-flags', '+cgop', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-colorspace', 'bt709', '-color_range', 'tv',
      '-fps_mode', 'cfr',
      '-pix_fmt', 'yuv420p',
    );

    if (hasAudio) {
      ffmpegArgs.push(
        '-c:a', 'aac',
        '-b:a', '384k',
        '-ar', '48000',
        '-ac', '2',
        '-af', `apad,atrim=duration=${totalFrames / fps}`,
      );
    }

    ffmpegArgs.push('-t', String(totalFrames / fps), '-movflags', '+faststart', tempMp4);

    ffmpegProc = spawn(ffmpeg, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let ffmpegErr = '';
    ffmpegProc.stderr.on('data', d => { ffmpegErr += d.toString(); });

    const ffmpegPromise = new Promise((resolve, reject) => {
      ffmpegProc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}: ${ffmpegErr}`));
      });
      ffmpegProc.on('error', reject);
    });

    // Attach a handler immediately; a failed encoder must not leave a blocked pipe loop.
    let encoderFailure = null;
    ffmpegPromise.catch(err => { encoderFailure = err; });
    ffmpegProc.stdin.on('error', err => { encoderFailure = err; });

    const captureSession = await context.newCDPSession(page);

    // 4. Pure Frame-Stepping Loop: compute strictly as f(frameIdx, fps)
    for (let f = 0; f < totalFrames; f++) {
      await page.evaluate(frameIdx => { window.__renderAtFrame(frameIdx); document.getElementById('viewport').getBoundingClientRect(); }, f);

      if (telemetryFrames.has(f)) {
        const tel = await page.evaluate(() => window.__measureLayoutTelemetry());
        if (tel) {
          telemetrySamples.push({ frame: f, tMs: Number(((f / fps) * 1000).toFixed(1)), ...tel });
        }
      }

      const capture = await captureSession.send('Page.captureScreenshot', preview
        ? { format: 'jpeg', quality: 80, fromSurface: true, captureBeyondViewport: false }
        : { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false });
      const frameBuffer = Buffer.from(capture.data, 'base64');
      if (encoderFailure) throw encoderFailure;
      if (!ffmpegProc.stdin.write(frameBuffer)) await Promise.race([once(ffmpegProc.stdin, 'drain'), ffmpegPromise]);
      if (encoderFailure) throw encoderFailure;

      if (onProgress && f % 45 === 0) {
        onProgress({ frame: f, totalFrames, pct: Math.round((f / totalFrames) * 100) });
      }
    }

    ffmpegProc.stdin.end();
    await ffmpegPromise;
    renameSync(tempMp4, outputMp4);
    writeFileSync(join(outDir, `${preview ? 'preview-' : ''}layout-telemetry-${thumbSuffix}.json`), JSON.stringify(telemetrySamples, null, 2));
    renderComplete = true;
  } finally {
    if (!renderComplete) {
      ffmpegProc?.stdin?.destroy();
      ffmpegProc?.kill('SIGTERM');
      try { unlinkSync(tempMp4); } catch {}
    }
    await context.close();
    if (ownBrowser) await browser.close();
  }

  return {
    aspect,
    width,
    height,
    fps,
    totalFrames,
    durationMs: activeDurationMs,
    videoPath: outputMp4,
    thumbnailPath: thumbPng,
    telemetrySamples,
  };
}

/**
 * Render both 16:9 Widescreen and 9:16 Vertical Shorts MP4s sharing a single browser process.
 */
export async function renderBattleVideos({
  idOrManifest,
  baseUrl = 'http://127.0.0.1:3000',
  aspects = ['16:9', '9:16'],
  preview = false,
  debugSafeZones = false,
  overrides = {},
}) {
  const manifest = typeof idOrManifest === 'string' ? loadManifest(idOrManifest) : idOrManifest;
  if (!manifest) throw new Error('Battle manifest not found');

  const executablePath = getChromeExecutablePath();
  if (!executablePath) throw new Error('Chrome/Brave executable not found in /Applications');

  const browser = await launchStudioBrowser(executablePath);
  const outputs = { telemetry: {} };
  try {
    for (const aspect of aspects) {
      const res = await renderAspectVideo({
        manifest,
        baseUrl,
        aspect,
        preview,
        debugSafeZones,
        overrides,
        browser,
      });
      if (res.aspect === '16:9') {
        outputs.video16x9 = res.videoPath;
        outputs.thumbnail16x9 = res.thumbnailPath;
        outputs.telemetry['16:9'] = res.telemetrySamples;
      } else {
        outputs.video9x16Shorts = res.videoPath;
        outputs.thumbnail9x16 = res.thumbnailPath;
        outputs.telemetry['9:16'] = res.telemetrySamples;
      }
    }
  } finally {
    await browser.close();
  }
  return outputs;
}
