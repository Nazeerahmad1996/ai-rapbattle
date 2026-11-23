import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAdapters, getAdapter, bindModel } from './adapters/index.js';
import { runBattle, tally } from './engine.js';
import { MODES, listModes } from './modes.js';
import { saveBattle, loadBattle, listBattles } from './store.js';
import { synthesizeSpeech } from './tts.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VIDEOS_DIR, produceAutomatedBattle, loadManifest, getCapabilities } from './automation.js';
import { renderBattleVideos } from './video-renderer.js';
import { reviewAndFixBattleVideo } from './video-reviewer.js';
import { requestedDeliveryFiles } from './delivery-policy.js';

const PORT = Number(process.env.PORT) || 3000;
// Loopback only by default: this server can spend your AI subscriptions, so don't expose it to the network.
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CONCURRENT_BATTLES = 2;
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
  ...(process.env.ALLOWED_HOSTS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
]);
const API_TOKEN = process.env.BOTBRAWL_API_TOKEN?.trim() || '';

const hasValidToken = req => {
  if (!API_TOKEN) return false;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${API_TOKEN}`) return true;
  if (req.query?.token === API_TOKEN) return true;
  return false;
};

const app = express();
app.disable('x-powered-by');

// --- Security middleware -------------------------------------------------------------------
// 1. Host check blocks DNS-rebinding (unless authenticated via BOTBRAWL_API_TOKEN).
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host) && !hasValidToken(req)) {
    return res.status(403).json({ error: 'forbidden host' });
  }
  next();
});
// 2. Origin check on state-changing requests blocks cross-site request forgery.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || hasValidToken(req)) return next();
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'forbidden origin' });
  next();
});
// 3. Browser hardening headers.
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));

const live = new Map(); // id -> { battle, clients:Set, controller } — only while running

app.get('/api/adapters', (_req, res) => {
  res.json(getAdapters().map(a => ({ id: a.id, name: a.name, color: a.color, available: a.available(), models: a.models() })));
});

app.get('/api/modes', (_req, res) => res.json(listModes()));

// --- Agent-First Discovery & Automation Endpoints for Grokbot ---
app.get('/llms.txt', (_req, res) => {
  const cap = getCapabilities();
  res.type('text/plain').send([
    '# BotBrawl — Agent & Grokbot Automation Guide',
    '',
    '## Quickest CLI Command (Self-Starting, Idempotent, Pure JSON stdout)',
    'npm run grokbot',
    '',
    '## Custom CLI Flags',
    'npm run grokbot -- --mode rap --language English --rounds 2 --force',
    '',
    '## HTTP API Endpoints',
    '- GET  /api/automation/capabilities',
    '- POST /api/automation/produce  (body: { mode?, language?, topic?, rounds?, lines?, a?, b?, judge?, renderVideo?: true })',
    '- GET  /api/automation/battles/:id/manifest',
    '',
    `## Supported Modes: ${cap.modes.map(m => m.id).join(', ')}`,
    `## Supported Languages: ${cap.languages.join(', ')}`,
    `## Available Adapters: ${cap.adapters.filter(a => a.available).map(a => a.id).join(', ')}`,
  ].join('\n'));
});

app.get('/api/automation/capabilities', (_req, res) => {
  res.json({ ok: true, data: getCapabilities() });
});

app.get('/api/automation/battles/:id/manifest', (req, res) => {
  const m = loadManifest(req.params.id);
  m ? res.json({ ok: true, data: m }) : res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Manifest not found' } });
});

app.get('/api/automation/battles/:id/audio/:stem.mp3', (req, res) => {
  const { id, stem } = req.params;
  if (!/^[a-f0-9]{8}$/.test(id)) return res.status(400).end();
  let fileName = null;
  if (/^\d+$/.test(stem)) fileName = `audio-${stem}.mp3`;
  else if (stem === 'shorts-intro' || stem === 'shorts-outro') fileName = `${stem}.mp3`;
  if (!fileName) return res.status(400).end();
  const file = join(VIDEOS_DIR, id, fileName);
  if (!existsSync(file)) return res.status(404).end();
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=3600' });
  res.sendFile(file);
});

app.post('/api/automation/produce', async (req, res) => {
  try {
    const body = req.body ?? {};
    const manifest = await produceAutomatedBattle(body);
    let files = {
      manifestJson: join(VIDEOS_DIR, manifest.id, 'manifest.json'),
      metadataJson: join(VIDEOS_DIR, manifest.id, 'youtube-metadata.json'),
    };
    let quality = null;
    if (body.renderVideo !== false) {
      const aspects = Array.isArray(body.aspects) ? body.aspects : ['16:9', '9:16'];
      const rendered = await renderBattleVideos({
        idOrManifest: manifest,
        baseUrl: `http://127.0.0.1:${PORT}`,
        aspects,
        beat: body.beat !== false,
      });
      files = { ...files, ...requestedDeliveryFiles(rendered, aspects) };
      quality = await reviewAndFixBattleVideo({ battleId: manifest.id, aspects, maxReviews: 4, baseUrl: `http://127.0.0.1:${PORT}`, beat: body.beat !== false });
      files.reviewJson = join(VIDEOS_DIR, manifest.id, 'review.json');
    }
    res.json({
      ok: true,
      battleId: manifest.id,
      quality,
      files,
      youtube: manifest.youtube,
      manifest,
    });
  } catch (e) {
    const cap = getCapabilities();
    res.status(400).json({
      ok: false,
      error: {
        code: 'AUTOMATION_ERROR',
        message: e.message,
        valid_modes: cap.modes.map(m => m.id),
        valid_languages: cap.languages,
        suggested_fix: 'Check mode/language parameters or omit them to let Auto-Director choose.',
      },
    });
  }
});

app.post('/api/tts', async (req, res) => {
  try {
    const body = req.body ?? {};
    const text = cleanText(str(body.text, 2500));
    if (!text) return res.status(400).json({ error: 'text required' });
    const language = cleanText(str(body.language, 40)) || 'English';
    const role = str(body.role, 10) || 'a';
    const mode = str(body.mode, 20) || 'rap';
    const mp3 = await synthesizeSpeech({ text, language, role, mode });
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    res.send(mp3);
  } catch (e) {
    res.status(502).json({ error: e.message || 'TTS unavailable' });
  }
});

app.get('/api/battles', (_req, res) => res.json(listBattles()));
app.get('/api/battles/:id', (req, res) => {
  const b = loadBattle(req.params.id);
  b ? res.json(b) : res.status(404).json({ error: 'not found' });
});

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// Strip control characters so user text can't smuggle odd formatting into prompts or logs.
const cleanText = s => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const intIn = (v, min, max, dflt) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && Number(v) ? Math.trunc(Number(v)) : dflt));

app.post('/api/battles', (req, res) => {
  try {
    if (live.size >= MAX_CONCURRENT_BATTLES) {
      return res.status(429).json({ error: `Only ${MAX_CONCURRENT_BATTLES} battles can run at once. Wait for one to finish or stop it.` });
    }
    const body = req.body ?? {};
    const topic = cleanText(str(body.topic, 200));
    if (!topic) throw new Error('topic required');
    const mode = str(body.mode, 20) || 'rap';
    if (!Object.hasOwn(MODES, mode)) throw new Error(`Unknown mode: ${mode}`);
    const language = cleanText(str(body.language, 40)) || 'English';
    const rounds = intIn(body.rounds, 1, 5, 3);
    const lines = intIn(body.lines, 2, 16, MODES[mode].length);

    const adapters = getAdapters();
    const fa = bindModel(getAdapter(str(body.a, 40), adapters), str(body.aModel, 80));
    const fb = bindModel(getAdapter(str(body.b, 40), adapters), str(body.bModel, 80));
    if (fb.color === fa.color) fb.color = '#4da3ff'; // keep mirror matches visually distinct
    const judgeId = str(body.judge, 40);
    const j = judgeId && judgeId !== 'none' ? bindModel(getAdapter(judgeId, adapters), str(body.judgeModel, 80)) : null;
    for (const x of [fa, fb, j].filter(Boolean)) if (!x.available()) throw new Error(`${x.name} CLI is not installed`);

    const id = randomUUID().slice(0, 8);
    const battle = {
      id, createdAt: Date.now(), status: 'running',
      config: { mode, topic, language, rounds, lines, clean: body.clean === true },
      fighters: [fa, fb].map(f => ({ id: f.id, name: f.name, color: f.color })),
      judge: j && { id: j.id, name: j.name },
      events: [], votes: { a: 0, b: 0 },
    };
    const controller = new AbortController();
    const entry = { battle, clients: new Set(), controller };
    live.set(id, entry);

    const emit = ev => {
      battle.events.push(ev);
      for (const c of entry.clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    runBattle({ config: battle.config, fighters: [fa, fb], judge: j, emit, signal: controller.signal })
      .then(r => { battle.status = 'voting'; battle.totals = r.totals; })
      .catch(e => { battle.status = 'error'; emit({ type: 'error', message: controller.signal.aborted ? 'Battle stopped' : e.message }); })
      .finally(() => {
        try { saveBattle(battle); } catch (e) { console.error('failed to save battle', id, e.message); }
        for (const c of entry.clients) c.end();
        entry.clients.clear();
        live.delete(id); // free memory; finished battles are served from disk
      });
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/battles/:id/stream', (req, res) => {
  const entry = live.get(req.params.id);
  const stored = entry?.battle ?? loadBattle(req.params.id);
  if (!stored) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  for (const ev of stored.events) res.write(`data: ${JSON.stringify(ev)}\n\n`); // replay
  if (entry && stored.status === 'running') {
    entry.clients.add(res);
    req.on('close', () => entry.clients.delete(res));
  } else res.end();
});

app.post('/api/battles/:id/stop', (req, res) => {
  live.get(req.params.id)?.controller.abort();
  res.json({ ok: true });
});

app.post('/api/battles/:id/vote', (req, res) => {
  const b = live.get(req.params.id)?.battle ?? loadBattle(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  if (b.status !== 'voting') return res.status(409).json({ error: 'voting is not open for this battle' });
  const side = req.body?.side;
  if (side !== 'a' && side !== 'b') return res.status(400).json({ error: 'bad side' });
  b.votes[side]++;
  b.final = tally(b.totals ?? { a: 0, b: 0 }, b.votes);
  saveBattle(b);
  res.json({ votes: b.votes, final: b.final });
});

// Malformed JSON and other errors: return JSON instead of an HTML stack trace.
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status === 500 ? 'internal error' : 'bad request' });
});

// Last-resort safety nets so one bad battle can't take the whole server down.
process.on('unhandledRejection', e => console.error('unhandled rejection:', e));

const server = app.listen(PORT, HOST, () => console.log(`🥊 BotBrawl arena: http://localhost:${PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const { controller } of live.values()) controller.abort(); // kill spawned CLIs
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
