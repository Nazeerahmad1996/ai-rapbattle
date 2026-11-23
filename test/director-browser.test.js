import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const runBrowser = process.env.RUN_STUDIO_BROWSER_TESTS === '1';
const timeline = (role = 'a') => ({
  fps: 30,
  beatGrid: { beatMs: 666.67, offsetMs: 0 },
  events: [
    { type: 'round-start', startMs: 0, endMs: 300, round: 1, camera: 'wide-establish' },
    { type: 'camera-cut', startMs: 300, endMs: 600, camera: 'hero-close' },
    { type: 'camera-cut', startMs: 410, endMs: 800, camera: 'rivalry-angle' },
    { type: 'speaker-switch', startMs: 4800, endMs: 5200, payload: { toSide: 'b' } },
    { type: 'round-start', startMs: 8000, endMs: 8300, round: 2 },
  ],
  lines: [
    { segmentType: 'verse', role: 'a', side: 'a', round: 1, startMs: 1000, endMs: 4500 },
    { segmentType: 'verse', role: 'b', side: 'b', round: 2, startMs: 8500, endMs: 12000 },
    { segmentType: 'judge', role: 'judge', startMs: 12400, endMs: 16000 },
  ],
  captionPages: [{ index: 0, role, startFrame: 300, endFrame: 330, words: [{ text: role === 'b' ? 'SHORT EDITION' : 'WIDE EDITION', highlightFrame: 300, highlightEndFrame: 330 }] }],
});

// Opt-in integration check: RUN_STUDIO_BROWSER_TESTS=1 node --test test/director-browser.test.js
// No server, network, AI calls, audio generation, or video encode is involved.
test('director chooses aspect edition, seeks deterministically, and follows 30/60 fps timestamps', { skip: !runBrowser, timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, timeout: 15000 });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'studio.test') return route.abort();
      const file = resolve('public', '.' + url.pathname);
      if (!file.startsWith(resolve('public') + '/')) return route.abort();
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
      await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || 'application/octet-stream' });
    });
    page.on('pageerror', error => console.error(error.message));
    await page.goto('http://studio.test/director.html');

    await page.waitForFunction(() => Boolean(window.__initDirectorStage));
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode().catch(() => {}))); });
    const manifest = {
      battle: { config: { mode: 'rap', topic: 'A test of steady broadcast motion' }, fighters: [{ name: 'VIOLET' }, { name: 'LIME' }] },
      timelineV2: timeline('a'), shortsTimelineV2: timeline('b'),
    };
    await page.evaluate(m => window.__initDirectorStage(m, '9:16'), manifest);
    const frame30 = await page.evaluate(() => window.__renderAtFrame(305, 30));
    assert.equal(await page.locator('#caption-page').innerText(), 'SHORT EDITION');
    const dom30 = await page.locator('body').innerHTML();
    const shot30 = await page.screenshot();
    const samePixels = async actual => {
      if (actual.equals(shot30)) return true;
      // Chrome may round GPU-composited pixels by one or two channel levels between
      // captures; exact DOM and transform equality is asserted independently.
      return page.evaluate(async ({ a, b }) => {
        const pixels = async base64 => {
          const img = new Image(); img.src = `data:image/png;base64,${base64}`; await img.decode();
          const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const A = await pixels(a), B = await pixels(b);
        let changed = 0;
        for (let i = 0; i < A.length; i++) { const d = Math.abs(A[i] - B[i]); if (d > 2) return false; if (d) changed++; }
        return changed / A.length < 0.0001;
      }, { a: shot30.toString('base64'), b: actual.toString('base64') });
    };
    const frame60 = await page.evaluate(() => window.__renderAtFrame(610, 60));
    assert.equal(frame60.caption.pageIndex, frame30.caption.pageIndex);
    assert.equal(await page.locator('body').innerHTML(), dom30);
    assert.ok(await samePixels(await page.screenshot()), 'Equivalent rendered frames should have visually identical pixels');
    await page.evaluate(() => window.__renderAtFrame(25, 30));
    await page.evaluate(() => window.__renderAtFrame(450, 30));
    assert.equal(await page.locator('#plate-state-a').innerText(), 'JUDGE SCORECARD');
    assert.equal(await page.locator('#plate-state-b').innerText(), 'JUDGE SCORECARD');
    await page.evaluate(() => window.__renderAtFrame(305, 30));
    assert.ok(await samePixels(await page.screenshot()), 'Seeking should reproduce the same visible frame');
    const telemetry = await page.evaluate(() => window.__measureLayoutTelemetry());
    assert.ok(telemetry.regions.some(r => r.id === 'caption-page'));
    assert.equal(telemetry.safeZoneViolations.length, 0, JSON.stringify(telemetry.safeZoneViolations));
    assert.equal(telemetry.textOverflows.length, 0, JSON.stringify(telemetry.textOverflows));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(m => window.__initDirectorStage(m, '16:9'), manifest);
    await page.evaluate(() => window.__renderAtFrame(305, 30));
    assert.equal(await page.locator('#caption-page').innerText(), 'WIDE EDITION');
    // Reinitialization must not accumulate inset clones.
    assert.equal(await page.locator('.performer-inset').count(), 2);
    const wideTelemetry = await page.evaluate(() => window.__measureLayoutTelemetry());
    assert.equal(wideTelemetry.safeZoneViolations.length, 0, JSON.stringify(wideTelemetry.safeZoneViolations));
    assert.equal(wideTelemetry.textOverflows.length, 0, JSON.stringify(wideTelemetry.textOverflows));
    await page.evaluate(m => window.__initDirectorStage(m, '16:9', { reducedMotion: true }), manifest);
    await page.evaluate(() => window.__renderAtFrame(305, 30));
    assert.equal(await page.locator('#camera-rig').getAttribute('style'), 'transform: translate3d(0px, 0px, 0px) scale(1) rotate(0deg);');
  } finally { await browser.close(); }
});
