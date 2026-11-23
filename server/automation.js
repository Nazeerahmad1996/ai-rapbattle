import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapters, getAdapter, bindModel } from './adapters/index.js';
import { runBattle, tally } from './engine.js';
import { MODES, LANGUAGES, getMode, listModes } from './modes.js';
import { TOPICS, findTopic } from './topics.js';
import { saveBattle, listBattles } from './store.js';
import { synthesizeSpeechWithTimings, synthesizeLineStemsBatch } from './tts.js';
import { splitIntoSpokenLines, pickHookPunchline, buildMasterTimelineV2 } from './timeline-v2.js';
import { forceAlignBatch } from './forced-aligner.js';
import { mixMasterBattleAudio } from './audio-mixer.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
export const VIDEOS_DIR = join(ROOT_DIR, 'data', 'videos');
export const DEFAULT_ENV_PATH = join(ROOT_DIR, '.env');

/** Zero-dependency .env loader so CLI, scheduled background runs, and MCP server automatically pick up YouTube OAuth keys. */
export function loadDotEnv(envPath = DEFAULT_ENV_PATH, { override = false } = {}) {
  if (!envPath || !existsSync(envPath)) return {};
  const loaded = {};
  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = cleaned.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') val = val.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    loaded[key] = val;
    if (override || process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return loaded;
}

/** Update or insert key=value pairs in .env while preserving existing comments and unrelated variables (mode 0600). */
export function upsertDotEnv(updates, envPath = DEFAULT_ENV_PATH) {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined && v !== null);
  const existingLines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
  const remaining = new Map(entries);
  const formatVal = v => {
    const s = String(v);
    return /[\s#"']/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
  };

  const nextLines = existingLines.map(rawLine => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) return rawLine;
    const cleaned = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eqIdx = cleaned.indexOf('=');
    if (eqIdx <= 0) return rawLine;
    const key = cleaned.slice(0, eqIdx).trim();
    if (!remaining.has(key)) return rawLine;
    const val = remaining.get(key);
    remaining.delete(key);
    return `${key}=${formatVal(val)}`;
  });

  if (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') nextLines.pop();
  for (const [key, val] of remaining.entries()) {
    nextLines.push(`${key}=${formatVal(val)}`);
  }
  writeFileSync(envPath, nextLines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  for (const [key, val] of entries) {
    process.env[key] = String(val);
  }
}

loadDotEnv();

const FFPROBE_CANDIDATES = ['ffprobe', '/Users/mac/.local/bin/ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'];
export function getFfprobeBin() {
  for (const bin of FFPROBE_CANDIDATES) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 2000 });
      return bin;
    } catch { /* try next */ }
  }
  return null;
}

const FFMPEG_CANDIDATES = ['ffmpeg', '/Users/mac/.local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
export function getFfmpegBin() {
  for (const bin of FFMPEG_CANDIDATES) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 2000 });
      return bin;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Turn verbose adapter+model strings like "Antigravity (Gemini 3.8 Flash (High))"
 * into clean broadcast stage names like "Gemini 3.8 Flash".
 */
export function formatStageName(rawName) {
  const s = String(rawName ?? '').trim();
  if (!s) return 'Challenger';
  const outer = s.match(/^([^()]+?)\s*\((.+)\)$/);
  if (!outer) return s;
  const platform = outer[1].trim();
  let inner = outer[2].trim();
  inner = inner.replace(/\s*\((?:High|Medium|Low|Default|Fast)\)\s*$/i, '').trim();
  if (!inner || /^default$/i.test(inner)) return platform;
  return inner;
}

/** Word-boundary-aware truncation so YouTube titles never chop mid-word. */
export function smartTruncate(str, maxLen) {
  const clean = String(str ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  if (maxLen <= 1) return clean.slice(0, Math.max(0, maxLen));
  const sliced = clean.slice(0, maxLen - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  const base = lastSpace >= Math.floor(maxLen * 0.55) ? sliced.slice(0, lastSpace) : sliced;
  return base.replace(/[,:;.\-–—\s]+$/, '') + '…';
}

/** Measure decoded media duration. Unknown duration must not silently desynchronize captions. */
export function probeMp3DurationMs(mp3FileOrBuffer, bufferLen = 0) {
  const ffprobe = getFfprobeBin();
  if (ffprobe && typeof mp3FileOrBuffer === 'string' && existsSync(mp3FileOrBuffer)) {
    try {
      const out = execFileSync(ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        mp3FileOrBuffer,
      ], { encoding: 'utf8', timeout: 4000 }).trim();
      const sec = Number(out);
      if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
    } catch { /* fall through */ }
  }
  throw new Error('Cannot measure speech duration with ffprobe; refusing estimated production timing');
}

/** Build a fallback chain of available fighters so a quota limit on one CLI never breaks Grokbot's daily run. */
export function buildFailoverPool(adapters = getAdapters()) {
  const pool = [];
  const antigravity = adapters.find(a => a.id === 'antigravity' && a.available());
  if (antigravity) {
    pool.push(
      bindModel(antigravity, 'gemini-3.8-flash-high'),
      bindModel(antigravity, 'gemini-4-argon-medium'),
      bindModel(antigravity, 'claude-sonnet-5-5-high'),
      bindModel(antigravity, 'gpt-oss-120b-medium'),
    );
  }
  for (const a of adapters) {
    if (!a.available()) continue;
    const firstModel = a.models()?.[0]?.id ?? '';
    pool.push(bindModel(a, firstModel));
  }
  return pool;
}

/** Wrap a bound fighter so if its primary CLI hits a quota/auth error, it transparently falls back. */
export function withFailover(primaryFighter, fallbackPool, sideLabel = 'a') {
  let active = primaryFighter;
  const contributors = [];
  const wrapped = {
    ...primaryFighter,
    stageName: primaryFighter.stageName || formatStageName(primaryFighter.name),
    contributors,
    async *generate(args) {
      const candidates = [active, ...fallbackPool.filter(f => !(f.id === active.id && f.model === active.model))];
      let firstError;
      for (const candidate of candidates) {
        if (args.signal?.aborted) throw args.signal.reason || new Error('Battle stopped');
        try {
          // Commit only a complete response; failed partial output must never leak.
          let response = '';
          for await (const chunk of candidate.generate(args)) response += chunk;
          if (!response.trim()) throw new Error('Model returned an empty response');
          if (args.signal?.aborted) throw args.signal.reason || new Error('Battle stopped');
          active = candidate;
          const identity = {
            id: candidate.id, model: candidate.model, name: candidate.name,
            stageName: candidate.stageName || formatStageName(candidate.name),
            color: primaryFighter.color,
          };
          Object.assign(wrapped, identity);
          if (!contributors.some(f => f.id === identity.id && f.model === identity.model)) contributors.push(identity);
          yield response;
          return;
        } catch (err) {
          if (args.signal?.aborted) throw err;
          firstError ||= err;
          console.error(`[grokbot-failover] Corner ${sideLabel.toUpperCase()} (${candidate.name}) failed (${err.message}); trying next available model`);
        }
      }
      throw firstError;
    },
  };
  return wrapped;
}

/** A corner can have multiple successful contributors if quota runs out mid-battle. */
export function resolvedFighter(fighter) {
  const contributors = fighter.contributors?.length ? fighter.contributors : [fighter];
  const latest = contributors.at(-1);
  return {
    id: latest.id, model: latest.model, color: fighter.color,
    name: contributors.map(f => f.name).join(' / '),
    stageName: contributors.map(f => f.stageName || formatStageName(f.name)).join(' / '),
    contributors: contributors.map(f => ({id:f.id, model:f.model, name:f.name, stageName:f.stageName || formatStageName(f.name)})),
  };
}

/** Build a rotating roster of distinct cross-family model rivalries so daily episodes stay fresh. */
export function buildRivalryRoster(availAdapters) {
  const roster = [];
  const agy = availAdapters.find(a => a.id === 'antigravity');
  const others = availAdapters.filter(a => a.id !== 'antigravity');

  if (agy) {
    const agyPairs = [
      ['gemini-3.8-flash-high', 'claude-sonnet-5-5-high'],
      ['claude-opus-5-5-high', 'gemini-4-argon-high'],
      ['gemini-4-argon-medium', 'claude-sonnet-5-5-high'],
      ['gpt-oss-120b-medium', 'gemini-3.8-flash-high'],
      ['claude-opus-5-5-medium', 'gpt-oss-120b-medium'],
    ];
    for (const [mA, mB] of agyPairs) {
      try {
        roster.push([bindModel(agy, mA), bindModel(agy, mB)]);
      } catch { /* skip if model catalog changed */ }
    }
  }

  // Interleave cross-CLI rivalries whenever additional CLIs (Claude Code, Codex, Kimi) are available
  if (others.length >= 2) {
    for (let i = 0; i < others.length; i++) {
      const a1 = others[i];
      const a2 = others[(i + 1) % others.length];
      roster.push([bindModel(a1, a1.models()?.[0]?.id ?? ''), bindModel(a2, a2.models()?.[0]?.id ?? '')]);
    }
  } else if (others.length === 1 && agy) {
    const ext = others[0];
    roster.push([bindModel(ext, ext.models()?.[0]?.id ?? ''), bindModel(agy, 'gemini-4-argon-high')]);
  }

  if (!roster.length) {
    const a1 = availAdapters[0];
    const a2 = availAdapters[1] ?? availAdapters[0];
    roster.push([bindModel(a1, ''), bindModel(a2, '')]);
  }
  return roster;
}

/** Automatically pick a fresh daily mode, unplayed topic, and rotating model rivalry. */
export function pickDailySetup(overrides = {}, adapters = getAdapters()) {
  const modeIds = Object.keys(MODES);
  const pastBattles = listBattles();
  const lastMode = pastBattles[0]?.config?.mode;
  const nextModeIdx = lastMode ? (modeIds.indexOf(lastMode) + 1) % modeIds.length : 0;
  const mode = overrides.mode && Object.hasOwn(MODES, overrides.mode) ? overrides.mode : modeIds[nextModeIdx];

  const usedTopics = new Set(pastBattles.filter(b => b.config?.mode === mode).map(b => b.config?.topic));
  const modeTopics = TOPICS[mode] ?? [];
  const unusedTopic = modeTopics.find(t => !usedTopics.has(t.title)) ?? modeTopics[pastBattles.length % Math.max(1, modeTopics.length)];
  const topic = (overrides.topic ?? '').trim() || unusedTopic?.title || MODES[mode].topic;

  const language = overrides.language && Object.hasOwn(LANGUAGES, overrides.language) ? overrides.language : (overrides.language || 'English');
  const rounds = Math.min(5, Math.max(1, Number(overrides.rounds) || 2));
  const lines = Math.min(16, Math.max(2, Number(overrides.lines) || (rounds <= 2 ? Math.min(6, MODES[mode].length) : MODES[mode].length)));
  const clean = overrides.clean !== false;

  const avail = adapters.filter(a => a.available());
  if (!avail.length) throw new Error('No AI CLI adapters are installed on this machine.');

  const agy = avail.find(a => a.id === 'antigravity');
  const roster = buildRivalryRoster(avail);
  const pairIdx = pastBattles.length % roster.length;
  const flipSides = Math.floor(pastBattles.length / roster.length) % 2 === 1;
  const [rotA, rotB] = flipSides ? [roster[pairIdx][1], roster[pairIdx][0]] : roster[pairIdx];

  let fa, fb, judge;
  if (overrides.a) {
    fa = bindModel(getAdapter(overrides.a, adapters), overrides.aModel || '');
  } else if (overrides.aModel && agy) {
    fa = bindModel(agy, overrides.aModel);
  } else {
    fa = rotA;
  }

  if (overrides.b) {
    fb = bindModel(getAdapter(overrides.b, adapters), overrides.bModel || '');
  } else if (overrides.bModel && agy) {
    fb = bindModel(agy, overrides.bModel);
  } else {
    fb = rotB;
  }

  fa.stageName = formatStageName(fa.name);
  fb.stageName = formatStageName(fb.name);
  if (fb.color === fa.color) fb.color = '#4da3ff';

  if (overrides.judge === 'none') {
    judge = null;
  } else if (overrides.judge) {
    judge = bindModel(getAdapter(overrides.judge, adapters), overrides.judgeModel || '');
  } else if (agy) {
    judge = bindModel(agy, overrides.judgeModel || 'gemini-3.8-flash-medium');
  } else {
    judge = bindModel(avail[0], '');
  }

  return { mode, topic, language, rounds, lines, clean, fa, fb, judge };
}

function formatTimestamp(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export function layoutTimelineSegments(segments, { introPadMs = 280, turnGapMs = 380, outroHoldMs = 1800 } = {}) {
  let cursorMs = introPadMs;
  const timeline = [];
  for (const seg of segments) {
    const startMs = cursorMs;
    const durationMs = seg.durationMs;
    const endMs = startMs + durationMs;
    timeline.push({ ...seg, startMs, durationMs, endMs });
    cursorMs = endMs + turnGapMs;
  }
  return { timeline, totalDurationMs: cursorMs + outroHoldMs };
}

/** Build the master millisecond-locked timeline and YouTube SEO metadata from a finished battle + segment durations. */
export function buildTimelineAndMetadata({ battle, segments, shortsSegments = null }) {
  const sA = battle.fighters[0].stageName || formatStageName(battle.fighters[0].name);
  const sB = battle.fighters[1].stageName || formatStageName(battle.fighters[1].name);

  const { timeline, totalDurationMs } = layoutTimelineSegments(segments, {
    introPadMs: 300,
    turnGapMs: 420,
    outroHoldMs: 2000,
  });

  const chapters = [`00:00 Cold Open — ${sA} vs ${sB}`];
  for (const seg of timeline) {
    if (seg.type === 'verse' && seg.side === 'a') {
      const label = seg.suddenDeath ? 'Sudden-Death Overtime' : `${cap(MODES[battle.config.mode]?.round || 'Round')} ${seg.round}`;
      chapters.push(`${formatTimestamp(seg.startMs)} ${label}`);
    }
  }

  const shortsLayout = shortsSegments
    ? layoutTimelineSegments(shortsSegments, { introPadMs: 160, turnGapMs: 260, outroHoldMs: 1100 })
    : { timeline, totalDurationMs };

  const modeObj = getMode(battle.config.mode);
  const langSuffix = battle.config.language && battle.config.language !== 'English' ? ` (${battle.config.language})` : '';
  const preset = findTopic(battle.config.mode, battle.config.topic);
  const shortHookTopic = preset?.label || battle.config.topic;

  // Smart word-boundary truncation so titles NEVER cut mid-word and ALWAYS keep #Shorts intact
  const titlePrefix = `${sA} vs ${sB} — AI ${modeObj.name}: `;
  const titleTopicBudget = Math.max(12, 100 - titlePrefix.length - langSuffix.length);
  const title = `${titlePrefix}${smartTruncate(battle.config.topic, titleTopicBudget)}${langSuffix}`.slice(0, 100);

  const shortsPrefix = `${sA} vs ${sB}: `;
  const shortsSuffix = ` 🔥 AI ${modeObj.name} #Shorts`;
  let shortsTitle;
  if (shortsPrefix.length + shortsSuffix.length + 10 <= 100) {
    const budget = 100 - shortsPrefix.length - shortsSuffix.length;
    shortsTitle = `${shortsPrefix}${smartTruncate(battle.config.topic, budget)}${shortsSuffix}`;
  } else {
    const compactSuffix = ` 🔥 #Shorts`;
    const budget = Math.max(10, 100 - shortsPrefix.length - compactSuffix.length);
    shortsTitle = `${shortsPrefix}${smartTruncate(shortHookTopic, budget)}${compactSuffix}`;
  }

  const description = [
    `🥊 ${sA} takes on ${sB} in an AI ${modeObj.name}${langSuffix}!`,
    `Topic: "${battle.config.topic}"`,
    preset ? `Corner A (${sA}): ${preset.a}\nCorner B (${sB}): ${preset.b}` : '',
    ``,
    `Who won this clash? Drop "A" for ${sA} or "B" for ${sB} in the comments! 👇`,
    ``,
    `⏱️ Chapters:`,
    ...chapters,
    ``,
    `#AIRapBattle #BotBrawl #AIBattle #${modeObj.name.replace(/\s+/g, '')} #ArtificialIntelligence #Shorts`,
  ].filter((line, idx, arr) => !(line === '' && arr[idx - 1] === '')).join('\n');

  const rawPlatforms = [
    battle.fighters[0].name.split(' (')[0].trim(),
    battle.fighters[1].name.split(' (')[0].trim(),
  ];
  const tags = [...new Set([
    'AI Rap Battle',
    'BotBrawl',
    `AI ${modeObj.name}`,
    sA,
    sB,
    `${sA} vs ${sB}`,
    ...rawPlatforms,
    battle.config.language || 'English',
    'AI vs AI',
    'Shorts',
  ].filter(Boolean))];

  return {
    timeline,
    totalDurationMs,
    shortsTimeline: shortsLayout.timeline,
    shortsDurationMs: shortsLayout.totalDurationMs,
    youtube: { title, shortsTitle, description, tags, chapters },
  };
}

const cap = s => s[0] + s.slice(1).toLowerCase();

/**
 * Full automated production:
 * 1. Runs battle with automatic CLI quota failover + sudden-death tiebreaker
 * 2. Synthesizes all neural MP3 stems + millisecond word timings IN PARALLEL
 * 3. Builds both the full 16:9 broadcast timeline AND a 9:16 Shorts highlight cut
 */
export async function produceAutomatedBattle(options = {}) {
  const adapters = getAdapters();
  const setup = pickDailySetup(options, adapters);
  const failoverPool = buildFailoverPool(adapters);

  const fa = withFailover(setup.fa, failoverPool, 'a');
  const fb = withFailover(setup.fb, failoverPool, 'b');
  const judge = setup.judge ? withFailover(setup.judge, failoverPool, 'judge') : null;

  let sA = formatStageName(fa.name);
  let sB = formatStageName(fb.name);
  const preset = findTopic(setup.mode, setup.topic);

  const id = randomUUID().slice(0, 8);
  const battle = {
    id,
    createdAt: Date.now(),
    status: 'running',
    config: {
      mode: setup.mode,
      topic: setup.topic,
      language: setup.language,
      rounds: setup.rounds,
      lines: setup.lines,
      clean: setup.clean,
      suddenDeath: options.suddenDeath !== false,
    },
    fighters: [
      { id: fa.id, name: fa.name, stageName: sA, color: fa.color },
      { id: fb.id, name: fb.name, stageName: sB, color: fb.color },
    ],
    judge: judge && { id: judge.id, name: judge.name, stageName: formatStageName(judge.name) },
    events: [],
    votes: { a: 0, b: 0 },
  };

  const result = await runBattle({
    config: battle.config,
    fighters: [fa, fb],
    judge,
    emit: ev => battle.events.push(ev),
  });

  battle.fighters = [fa, fb].map(resolvedFighter);
  battle.judge = judge ? resolvedFighter(judge) : null;
  battle.rounds = result.rounds;
  sA = battle.fighters[0].stageName;
  sB = battle.fighters[1].stageName;
  battle.status = 'voting';
  battle.totals = result.totals;
  battle.final = tally(result.totals, battle.votes);
  saveBattle(battle);

  const outDir = join(VIDEOS_DIR, id);
  mkdirSync(outDir, { recursive: true });

  const modeObj = getMode(setup.mode);
  const hookTopic = preset?.label || smartTruncate(setup.topic, 54);

  // 1. Snappy ~3.2s Cold-Open Intro Hook using clean Stage Names (no nested parentheses!)
  const introText = setup.language === 'English'
    ? `${sA} versus ${sB}! ${modeObj.name}: ${hookTopic}. Let's go!`
    : `${sA} vs ${sB}! ${hookTopic}!`;

  const rawSegments = [
    {
      type: 'intro',
      round: 1,
      role: 'judge',
      speaker: 'Announcer',
      text: introText,
    },
  ];

  // 2. Round-by-round verses & punchy ringside judge verdicts
  for (const r of result.rounds) {
    rawSegments.push({
      type: 'verse',
      round: r.round,
      suddenDeath: Boolean(r.suddenDeath),
      side: 'a',
      role: 'a',
      speaker: r.performers?.a?.stageName || sA,
      text: r.verses.a,
    });
    rawSegments.push({
      type: 'verse',
      round: r.round,
      suddenDeath: Boolean(r.suddenDeath),
      side: 'b',
      role: 'b',
      speaker: r.performers?.b?.stageName || sB,
      text: r.verses.b,
    });
    if (r.scores && r.scores.reason) {
      rawSegments.push({
        type: 'judge',
        round: r.round,
        suddenDeath: Boolean(r.suddenDeath),
        role: 'judge',
        speaker: 'Adjudicator',
        text: r.scores.reason,
        scores: r.scores,
        totals: {
          a: result.rounds.slice(0, result.rounds.indexOf(r) + 1).reduce((sum, x) => sum + (x.scores?.a || 0), 0),
          b: result.rounds.slice(0, result.rounds.indexOf(r) + 1).reduce((sum, x) => sum + (x.scores?.b || 0), 0),
        },
      });
    }
  }

  // 3. Comment-bait Outro Verdict
  const winnerStageName = battle.final.winner === 'draw'
    ? null
    : (battle.final.winner === 'a' ? sA : sB);
  const winnerLine = !winnerStageName
    ? "Dead heat draw!"
    : `${winnerStageName} takes it ${battle.totals.a} to ${battle.totals.b}!`;
  const outroText = setup.language === 'English'
    ? `${winnerLine} Who won in your book? Drop A or B in the comments!`
    : winnerLine;
  rawSegments.push({
    type: 'outro',
    round: result.rounds.at(-1)?.round || setup.rounds,
    role: 'judge',
    speaker: 'Announcer',
    text: outroText,
    totals: battle.totals,
    winner: battle.final.winner,
  });

  // 4. Dedicated <2s Shorts Hook & <3s Shorts Flash Verdict stems
  const shortsIntroRaw = {
    type: 'intro',
    round: 1,
    role: 'judge',
    speaker: 'Announcer',
    fast: true,
    filePrefix: 'shorts-intro',
    text: setup.language === 'English'
      ? `${sA} vs ${sB}: ${hookTopic}!`
      : `${sA} vs ${sB}!`,
  };

  // Pick the highest-energy/highest-combined-score round for the 9:16 Shorts spotlight
  let bestRound = result.rounds[0];
  let bestScoreSum = -1;
  for (const r of result.rounds) {
    const scoreSum = (r.scores?.a || 0) + (r.scores?.b || 0) + (Math.abs((r.scores?.a || 0) - (r.scores?.b || 0)) * 0.5);
    if (scoreSum >= bestScoreSum) {
      bestScoreSum = scoreSum;
      bestRound = r;
    }
  }
  const bScores = bestRound?.scores || battle.totals;
  const shortsOutroRaw = {
    type: 'outro',
    round: bestRound?.round || 1,
    role: 'judge',
    speaker: 'Announcer',
    fast: true,
    filePrefix: 'shorts-outro',
    text: setup.language === 'English'
      ? `${bScores.a} to ${bScores.b}! Did the judge get it right? Comment A or B!`
      : `${bScores.a} - ${bScores.b}!`,
    totals: { a: bScores.a || battle.totals.a, b: bScores.b || battle.totals.b },
    winner: (bScores.a === bScores.b) ? battle.final.winner : (bScores.a > bScores.b ? 'a' : 'b'),
  };

  const synthSegment = async (seg, fileName, urlPath) => {
    const audioPath = join(outDir, fileName);
    let durationMs = 2400;
    let words = [];
    try {
      const res = await synthesizeSpeechWithTimings({
        text: seg.text,
        language: setup.language,
        role: seg.role,
        mode: setup.mode,
        type: seg.type,
        fast: Boolean(seg.fast),
      });
      writeFileSync(audioPath, res.audioBuffer);
      durationMs = probeMp3DurationMs(audioPath, res.audioBuffer.length);
      words = res.words || [];
    } catch (e) {
      console.error(`[tts-warning] ${fileName} fallback duration:`, e.message);
      durationMs = Math.max(1800, Math.min(12000, seg.text.length * 58));
    }
    return {
      ...seg,
      audioFile: fileName,
      audioPath,
      audioUrl: urlPath,
      durationMs,
      words,
    };
  };

  // Synthesize all neural voice stems concurrently (3x-5x faster than sequential loop)
  const [segments, shortsIntroSeg, shortsOutroSeg] = await Promise.all([
    Promise.all(
      rawSegments.map((seg, i) =>
        synthSegment({ index: i, ...seg }, `audio-${i}.mp3`, `/api/automation/battles/${id}/audio/${i}.mp3`),
      ),
    ),
    synthSegment(shortsIntroRaw, 'shorts-intro.mp3', `/api/automation/battles/${id}/audio/shorts-intro.mp3`),
    synthSegment(shortsOutroRaw, 'shorts-outro.mp3', `/api/automation/battles/${id}/audio/shorts-outro.mp3`),
  ]);

  // Assemble the dedicated punchy 9:16 Shorts cut (unless fullShorts=true was explicitly requested)
  let shortsSegments = null;
  if (!options.fullShorts && bestRound) {
    const verseASeg = segments.find(s => s.type === 'verse' && s.round === bestRound.round && s.side === 'a');
    const verseBSeg = segments.find(s => s.type === 'verse' && s.round === bestRound.round && s.side === 'b');
    if (verseASeg && verseBSeg) {
      shortsSegments = [
        { ...shortsIntroSeg, index: 0 },
        { ...verseASeg, index: 1, round: 1 },
        { ...verseBSeg, index: 2, round: 1 },
        { ...shortsOutroSeg, index: 3, round: 1 },
      ];
    }
  }

  const built = buildTimelineAndMetadata({ battle, segments, shortsSegments });

  // 5. Produce V2 Single Timeline & 48 kHz Stereo Master Soundtracks
  let timelineV2 = null;
  let shortsTimelineV2 = null;
  let audio16x9 = null;
  let audio9x16 = null;
  try {
    const v2Built = await prepareBattleStemsAndTimelineV2({
      battle,
      rounds: result.rounds,
      outDir,
      options,
      preset,
    });
    timelineV2 = v2Built.timelineV2;
    shortsTimelineV2 = v2Built.shortsTimelineV2;
    audio16x9 = v2Built.masterAudio16x9;
    audio9x16 = v2Built.masterAudio9x16;
  } catch (err) {
    throw new Error(`Studio production failed: ${err.message}`);
  }

  const manifest = {
    id,
    createdAt: battle.createdAt,
    roles: preset ? { label: preset.label, a: preset.a, b: preset.b } : null,
    battle: {
      id: battle.id,
      config: battle.config,
      fighters: battle.fighters,
      judge: battle.judge,
      totals: battle.totals,
      final: battle.final,
    },
    totalDurationMs: timelineV2 ? timelineV2.totalDurationMs : built.totalDurationMs,
    shortsDurationMs: shortsTimelineV2 ? shortsTimelineV2.totalDurationMs : built.shortsDurationMs,
    youtube: syncVideoChapters(built.youtube, timelineV2),
    timelineV2: timelineV2 || null,
    shortsTimelineV2: shortsTimelineV2 || null,
    audio16x9: audio16x9 || null,
    audio9x16: audio9x16 || null,
    timeline: built.timeline,
    shortsTimeline: built.shortsTimeline,
  };

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, 'youtube-metadata.json'), JSON.stringify(manifest.youtube, null, 2));
  return manifest;
}

/** Keep publishable chapter timestamps on the rendered clock, not the legacy UI clock. */
export function syncVideoChapters(metadata, timeline) {
  if (!timeline?.lines?.length) return metadata;
  const entries = [{ ms: 0, label: 'The matchup' }];
  const seen = new Set();
  for (const line of timeline.lines) {
    if (line.segmentType !== 'verse') continue;
    const key = `${line.round}:${line.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (line.startMs - entries.at(-1).ms >= 10000 && timeline.totalDurationMs - line.startMs >= 10000) {
      entries.push({ ms: line.startMs, label: `Round ${line.round} — ${line.speaker || ('Corner ' + line.side.toUpperCase())}` });
    }
  }
  // YouTube chapters need >=3 entries with >=10 seconds each; otherwise omit the chapter block.
  const chapters = entries.length >= 3 ? entries.map(e => `${formatTimestamp(e.ms)} ${e.label}`) : [];
  const description = String(metadata?.description || '').replace(/(?:\n)*⏱️ Chapters:\n[\s\S]*?(?=\n#|$)/, chapters.length ? '\n\n⏱️ Chapters:\n' + chapters.join('\n') + '\n' : '\n');
  return { ...metadata, chapters, description };
}

/**
 * Reconstruct battle rounds from event log if missing (e.g. from data/battles/*.json).
 */
export function extractRoundsFromBattle(battle) {
  if (Array.isArray(battle.rounds) && battle.rounds.length > 0) {
    return battle.rounds;
  }
  const rounds = [];
  const events = battle.events || [];
  let currentRound = null;
  for (const ev of events) {
    if (ev.type === 'round' || ev.type === 'round-start') {
      currentRound = {
        round: ev.round || 1,
        suddenDeath: Boolean(ev.suddenDeath),
        verses: { a: '', b: '' },
        scores: null,
      };
      rounds.push(currentRound);
    } else if (ev.type === 'verse-end' && currentRound) {
      if (ev.side === 'a' || ev.side === 'b') {
        currentRound.verses[ev.side] = ev.verse || '';
        if (ev.performer) (currentRound.performers ||= {})[ev.side] = ev.performer;
      }
    } else if (ev.type === 'round-end' && currentRound) {
      currentRound.scores = ev.scores || null;
    }
  }
  if (!rounds.length && battle.verses) {
    rounds.push({
      round: 1,
      suddenDeath: false,
      verses: { a: battle.verses.a || '', b: battle.verses.b || '' },
      scores: battle.scores || null,
    });
  }
  return rounds;
}

/** Letter-only contestant names are ambiguous in speech. Preserve sentence-initial articles. */
export function spokenJudgeReason(text) {
  return String(text || '').replace(/\b([AB])\b/g, (letter, _capture, offset, source) => {
    const before = source.slice(0, offset).trimEnd();
    const after = source.slice(offset + 1);
    const subjectVerb = /^\s+(?:wins|takes|clinches|edges|lands|delivers|beats|has|gets|is|uses|hits|leaves|scores)\b/.test(after);
    if (letter === 'A' && (!before || /[.!?]$/.test(before)) && !subjectVerb && !/^['’]s\b/.test(after)) return letter;
    if (/Corner$|Contestant$/.test(before)) return letter;
    return letter === 'A' ? 'the violet corner' : 'the lime corner';
  });
}

/**
 * High-craft V2 stem synthesis, word force-alignment, master timeline assembly,
 * and 48 kHz Stereo EBU R128 audio mastering for fresh battles or upgrading existing battles.
 */
export async function prepareBattleStemsAndTimelineV2({ battle, rounds, outDir, options = {}, preset = null }) {
  const sA = battle.fighters[0].stageName || formatStageName(battle.fighters[0].name);
  const sB = battle.fighters[1].stageName || formatStageName(battle.fighters[1].name);
  const lang = battle.config?.language || 'English';
  const mode = battle.config?.mode || 'rap';
  const ffmpeg = getFfmpegBin();
  const ffprobe = getFfprobeBin();

  const hookTeaser = pickHookPunchline(battle, rounds);
  const allLineItems = [];

  // 1. Cold-Open Mystery Hook (< 1.4s teaser)
  allLineItems.push({
    id: 'hook-0',
    segmentType: 'hook',
    role: 'judge',
    speaker: 'Announcer',
    text: hookTeaser.text,
    language: lang,
    mode,
    audioPath: join(outDir, 'stem-hook-0.wav'),
  });

  // 2. Round-by-round Verses & Judge Deliberations (Line-by-Line)
  for (const r of rounds) {
    for (const side of ['a', 'b']) {
      const verseText = r.verses?.[side] || '';
      const lines = splitIntoSpokenLines(verseText);
      const spk = r.performers?.[side]?.stageName || (side === 'a' ? sA : sB);
      lines.forEach((lineText, lineIdx) => {
        const isLast = lineIdx === lines.length - 1;
        const isKnockout = isLast && (r.round === rounds[rounds.length - 1].round);
        allLineItems.push({
          id: `r${r.round}-${side}-l${lineIdx}`,
          segmentType: 'verse',
          round: r.round,
          suddenDeath: Boolean(r.suddenDeath),
          side,
          role: side,
          speaker: spk,
          text: lineText,
          isPunchline: isLast,
          punchTier: isKnockout ? 'knockout' : 'mid',
          roundScores: r.scores,
          language: lang,
          mode,
          audioPath: join(outDir, `stem-r${r.round}-${side}-l${lineIdx}.wav`),
        });
      });
    }

    if (r.scores?.reason) {
      const spokenReason = spokenJudgeReason(r.scores.reason);
      const jLines = splitIntoSpokenLines(spokenReason);
      jLines.forEach((jText, jIdx) => {
        allLineItems.push({
          id: `r${r.round}-judge-l${jIdx}`,
          segmentType: 'judge',
          round: r.round,
          suddenDeath: Boolean(r.suddenDeath),
          role: 'judge',
          speaker: 'Adjudicator',
          text: jText,
          scores: r.scores,
          language: lang,
          mode,
          audioPath: join(outDir, `stem-r${r.round}-judge-l${jIdx}.wav`),
        });
      });
    }
  }

  // 3. Ending: Vote CTA & Winner Verdict
  const winnerStageName =
    battle.final?.winner === 'draw'
      ? 'Dead Heat Draw'
      : battle.final?.winner === 'a'
        ? sA
        : sB;

  allLineItems.push({
    id: 'vote-cta-0',
    segmentType: 'vote-cta',
    role: 'judge',
    speaker: 'Announcer',
    text: 'Who won this battle?',
    language: lang,
    mode,
    audioPath: join(outDir, 'stem-vote-cta-0.wav'),
  });

  allLineItems.push({
    id: 'outro-0',
    segmentType: 'outro',
    role: 'judge',
    speaker: 'Announcer',
    text: battle.final?.winner === 'draw' ? 'An even match.' : `The ${battle.final?.winner === 'a' ? 'violet' : 'lime'} corner wins.`,
    totals: battle.totals,
    winner: battle.final?.winner,
    language: lang,
    mode,
    audioPath: join(outDir, 'stem-outro-0.wav'),
  });

  // 4. Batch-Synthesize All Line Stems (Kokoro-82M on Apple Silicon, msedge-tts fallback)
  const synthResults = await synthesizeLineStemsBatch(allLineItems, {
    ffmpegBin: ffmpeg,
    probeDurationFn: probeMp3DurationMs,
  });

  for (const item of allLineItems) {
    const s = synthResults.get(item.id);
    if (!s?.ok || !existsSync(item.audioPath)) throw new Error(`Voice synthesis failed for ${item.id}; refusing a silent line`);
    item.durationMs = s.durationMs;
    item.voiceEngine = s.engine;
    item.voice = s.voice;
    item.barMeta = s.barMeta || null;
  }

  // 5. Batch Force-Align All Words (stable-ts + faster-whisper-large-v3)
  const wordsMap = forceAlignBatch(allLineItems, { model: 'large-v3' });
  for (const item of allLineItems) {
    item.words = wordsMap.get(item.id) || [];
    item.alignmentSource = item.words.length ? 'forced' : 'estimated';
  }

  // 6. Build Master Timeline V2
  const timelineV2 = buildMasterTimelineV2({
    battle,
    roles: preset ? { label: preset.label, a: preset.a, b: preset.b } : null,
    lineStems: allLineItems,
    fps: 60,
    captionFontScale: Number(options.captionFontScale || 1.0),
  });

  // 7. For Multi-Round Battles: Build Dedicated 1-Round Shorts Timeline Slice
  let shortsTimelineV2 = timelineV2;
  if (!options.fullShorts && rounds.length > 1) {
    let bestRound = rounds[0];
    let bestScoreSum = -1;
    for (const r of rounds) {
      const sum = (r.scores?.a || 0) + (r.scores?.b || 0);
      if (sum >= bestScoreSum) {
        bestScoreSum = sum;
        bestRound = r;
      }
    }
    const shortsLineStems = allLineItems.filter(
      item => item.segmentType === 'hook' || item.segmentType === 'vote-cta' || item.segmentType === 'outro' || (item.round === bestRound.round),
    );
    shortsTimelineV2 = buildMasterTimelineV2({
      battle,
      roles: preset ? { label: preset.label, a: preset.a, b: preset.b } : null,
      lineStems: shortsLineStems,
      fps: 60,
      captionFontScale: Number(options.captionFontScale || 1.0),
    });
  }

  // 8. 48 kHz Stereo Broadcast Mixing & Mastering (-14 LUFS, <= -1.1 dBTP)
  const masterAudio16x9 = join(outDir, 'master-audio-16x9.wav');
  const masterAudio9x16 = join(outDir, 'master-audio-9x16.wav');

  mixMasterBattleAudio({
    timelineV2,
    workDir: join(outDir, 'tmp-mix-16x9'),
    outputWavPath: masterAudio16x9,
    ffmpegBin: ffmpeg,
    ffprobeBin: ffprobe,
    beat: options.beat !== false,
    masterGainTrimDb: Number(options.masterGainTrimDb || 0.0),
    sidechainRatio: Number(options.sidechainRatio || 4.5),
  });

  if (shortsTimelineV2 === timelineV2) {
    mixMasterBattleAudio({
      timelineV2: shortsTimelineV2,
      workDir: join(outDir, 'tmp-mix-9x16'),
      outputWavPath: masterAudio9x16,
      ffmpegBin: ffmpeg,
      ffprobeBin: ffprobe,
      beat: options.beat !== false,
      masterGainTrimDb: Number(options.masterGainTrimDb || 0.0),
      sidechainRatio: Number(options.sidechainRatio || 4.5),
    });
  } else {
    mixMasterBattleAudio({
      timelineV2: shortsTimelineV2,
      workDir: join(outDir, 'tmp-mix-9x16'),
      outputWavPath: masterAudio9x16,
      ffmpegBin: ffmpeg,
      ffprobeBin: ffprobe,
      beat: options.beat !== false,
      masterGainTrimDb: Number(options.masterGainTrimDb || 0.0),
      sidechainRatio: Number(options.sidechainRatio || 4.5),
    });
  }

  return {
    timelineV2,
    shortsTimelineV2,
    masterAudio16x9,
    masterAudio9x16,
    allLineItems,
  };
}

/**
 * Upgrade an existing battle (such as baseline `bad08f04`) to V2 without changing battle JSON format.
 */
export async function upgradeBattleToV2(battleId, options = {}) {
  const existingManifest = loadManifest(battleId);
  const battleStorePath = join(ROOT_DIR, 'data', 'battles', `${battleId}.json`);
  let battle = null;
  if (existsSync(battleStorePath)) {
    battle = JSON.parse(readFileSync(battleStorePath, 'utf8'));
  } else if (existingManifest?.battle) {
    battle = existingManifest.battle;
  }
  if (!battle) {
    throw new Error(`Battle data not found for id: ${battleId}`);
  }

  const outDir = join(VIDEOS_DIR, battleId);
  mkdirSync(outDir, { recursive: true });

  const rounds = extractRoundsFromBattle(battle);
  const preset = findTopic(battle.config?.mode, battle.config?.topic);

  const v2Built = await prepareBattleStemsAndTimelineV2({
    battle,
    rounds,
    outDir,
    options,
    preset,
  });

  // Re-build YouTube metadata
  const built = buildTimelineAndMetadata({
    battle,
    segments: existingManifest?.timeline || [],
    shortsSegments: existingManifest?.shortsTimeline || null,
  });

  const updatedManifest = {
    ...(existingManifest || {}),
    id: battleId,
    createdAt: battle.createdAt || Date.now(),
    roles: preset ? { label: preset.label, a: preset.a, b: preset.b } : null,
    battle: {
      id: battle.id,
      config: battle.config,
      fighters: battle.fighters,
      judge: battle.judge,
      totals: battle.totals,
      final: battle.final,
    },
    totalDurationMs: v2Built.timelineV2.totalDurationMs,
    shortsDurationMs: v2Built.shortsTimelineV2.totalDurationMs,
    youtube: syncVideoChapters(existingManifest?.youtube || built.youtube, v2Built.timelineV2),
    timelineV2: v2Built.timelineV2,
    shortsTimelineV2: v2Built.shortsTimelineV2,
    audio16x9: v2Built.masterAudio16x9,
    audio9x16: v2Built.masterAudio9x16,
    timeline: existingManifest?.timeline || built.timeline,
    shortsTimeline: existingManifest?.shortsTimeline || built.shortsTimeline,
  };

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(updatedManifest, null, 2), 'utf8');
  writeFileSync(join(outDir, 'youtube-metadata.json'), JSON.stringify(updatedManifest.youtube, null, 2), 'utf8');
  return updatedManifest;
}

export function loadManifest(id) {
  if (!/^[a-f0-9]{8}$/.test(id)) return null;
  const p = join(VIDEOS_DIR, id, 'manifest.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Fast 2-second pre-flight diagnostic for Grokbot (`npm run grokbot -- --doctor`). */
export function runDoctorCheck(chromePath = null) {
  const ffmpeg = getFfmpegBin();
  const ffprobe = getFfprobeBin();
  let sidechainDucking = false;
  if (ffmpeg) {
    try {
      const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 3000 });
      sidechainDucking = filters.includes('sidechaincompress');
    } catch { /* ignore */ }
  }

  // Check Playwright's internal ffmpeg video capture helper
  const pwCacheDir = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  let playwrightFfmpeg = false;
  if (existsSync(pwCacheDir)) {
    try {
      playwrightFfmpeg = readdirSync(pwCacheDir).some(d => d.startsWith('ffmpeg-') && existsSync(join(pwCacheDir, d, 'ffmpeg-mac')));
    } catch { /* ignore */ }
  }

  const adapters = getAdapters().map(a => ({
    id: a.id,
    name: a.name,
    available: a.available(),
    modelCount: a.models().length,
  }));
  const availableAdapters = adapters.filter(a => a.available);

  loadDotEnv();
  const youtubeConfigured = Boolean(
    process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN,
  );
  const youtubeAuth = {
    configured: youtubeConfigured,
    missingEnvVars: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'].filter(k => !process.env[k]),
    setupCommand: youtubeConfigured ? null : 'npm run youtube-login',
  };

  const healthy = Boolean(ffmpeg && ffprobe && chromePath && playwrightFfmpeg && availableAdapters.length > 0);
  return {
    ok: healthy,
    readyForVideoProduction: healthy,
    readyForYouTubeUpload: healthy && youtubeAuth.configured,
    checks: {
      ffmpeg: { ok: Boolean(ffmpeg), path: ffmpeg, sidechainDucking },
      ffprobe: { ok: Boolean(ffprobe), path: ffprobe },
      chrome: { ok: Boolean(chromePath), path: chromePath },
      playwrightVideoHelper: {
        ok: playwrightFfmpeg,
        fixIfMissing: playwrightFfmpeg ? null : 'npx playwright-core install ffmpeg',
      },
      aiAdapters: {
        ok: availableAdapters.length > 0,
        availableCount: availableAdapters.length,
        adapters,
      },
      youtubeAuth,
    },
  };
}

export function getCapabilities() {
  const adapters = getAdapters().map(a => ({
    id: a.id,
    name: a.name,
    available: a.available(),
    models: a.models(),
  }));
  return {
    modes: listModes().map(m => ({ id: m.id, name: m.name, defaultLength: m.length, roundLabel: m.round })),
    languages: Object.keys(LANGUAGES),
    adapters,
    endpoints: {
      produce: 'POST /api/automation/produce',
      manifest: 'GET /api/automation/battles/:id/manifest',
      capabilities: 'GET /api/automation/capabilities',
      llmsTxt: 'GET /llms.txt',
    },
    cli: {
      dailyCommand: 'npm run grokbot',
      doctorCheck: 'npm run grokbot -- --doctor',
      youtubeLogin: 'npm run youtube-login',
      forceNewRun: 'npm run grokbot -- --force',
      shortsOnly: 'npm run grokbot -- --shorts-only --force',
      customRun: 'npm run grokbot -- --mode roast --language Hinglish --rounds 2 --force',
    },
  };
}
