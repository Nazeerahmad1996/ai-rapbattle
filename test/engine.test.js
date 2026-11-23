import test from "node:test";
import assert from "node:assert/strict";
import { runBattle, tally } from "../server/engine.js";
import { parseJudge } from "../server/judge.js";

const fake = (id, text) => ({
  id,
  name: id,
  color: "#fff",
  async *generate() {
    yield text.slice(0, 3);
    yield text.slice(3);
  },
});
const judge = {
  id: "j",
  name: "j",
  async *generate() {
    yield 'Sure! {"a": 7, "b": 9, "reason": "B flowed"} done';
  },
};

test("parseJudge tolerates prose and clamps", () => {
  assert.deepEqual(parseJudge('x {"a": 15, "b": 0, "reason": "r"} y'), {
    a: 10,
    b: 1,
    reason: "r",
  });
  assert.throws(() => parseJudge("nothing"));
});

test("battle runs rounds in order with judge scoring", async () => {
  const events = [];
  const r = await runBattle({
    config: { topic: "t", rounds: 2, lines: 4, clean: true },
    fighters: [fake("A", "verse A"), fake("B", "verse B")],
    judge,
    emit: (e) => events.push(e),
  });
  assert.equal(r.rounds.length, 2);
  assert.deepEqual(r.totals, { a: 14, b: 18 });
  const order = events
    .filter((e) => e.type === "verse-end")
    .map((e) => `${e.round}${e.side}`);
  assert.deepEqual(order, ["1a", "1b", "2a", "2b"]);
  assert.equal(events.at(-1).type, "end");
});

test("battle works without judge", async () => {
  const r = await runBattle({
    config: { topic: "t", rounds: 1, lines: 4 },
    fighters: [fake("A", "aaaa"), fake("B", "bbbb")],
    judge: null,
    emit: () => {},
  });
  assert.deepEqual(r.totals, { a: 0, b: 0 });
});

test("tally combines judge and votes", () => {
  assert.equal(tally({ a: 10, b: 12 }, { a: 5, b: 0 }).winner, "a");
  assert.equal(tally({ a: 10, b: 10 }, { a: 0, b: 0 }).winner, "draw");
});

import { versePrompt, cleanVerseText } from "../server/engine.js";
import { judgePrompt } from "../server/judge.js";
import { MODES } from "../server/modes.js";
import { listModes } from "../server/modes.js";
import { TOPICS, findTopic } from "../server/topics.js";
import { createPerformancePlan } from "../server/performance.js";
import { pickVoice, cleanForSpeech, getProsody } from "../server/tts.js";
import {
  withFailover,
  buildTimelineAndMetadata,
  getCapabilities,
  formatStageName,
  smartTruncate,
  buildRivalryRoster,
  loadDotEnv,
  upsertDotEnv,
} from "../server/automation.js";
import { synthesizeBattleBedWav } from "../server/audio-spice.js";
import { parseGoogleClientJson, cleanMacPath } from "../scripts/youtube-login.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("every mode builds distinct turn and judge prompts", () => {
  const base = {
    topic: "t",
    me: { name: "A" },
    foe: { name: "B" },
    round: 1,
    rounds: 2,
    lines: 4,
    history: [],
    clean: true,
  };
  const seen = new Set();
  for (const id of Object.keys(MODES)) {
    const p = versePrompt({ ...base, mode: id });
    assert.match(p, new RegExp(`Output ONLY your ${MODES[id].turn}`));
    seen.add(p);
    assert.match(
      judgePrompt({
        topic: "t",
        round: 1,
        a: { name: "A", verse: "x" },
        b: { name: "B", verse: "y" },
        mode: id,
      }),
      /"a":/,
    );
  }
  assert.equal(seen.size, Object.keys(MODES).length);
});

test("mirror match prompt marks which verses are yours and includes judge feedback", () => {
  const same = { name: "Codex" };
  const history = [
    { side: "a", round: 1, name: "Codex", verse: "A-verse-one" },
    { side: "b", round: 1, name: "Codex", verse: "B-verse-one" },
  ];
  const feedback = [{ round: 1, a: 6, b: 8, reason: "B had sharper rhymes." }];
  const p = versePrompt({
    topic: "t",
    me: same,
    foe: same,
    side: "b",
    round: 2,
    rounds: 3,
    lines: 4,
    history,
    feedback,
    clean: true,
    mode: "rap",
  });
  assert.match(p, /Contestant B \(you\)\]\nB-verse-one/);
  assert.match(p, /Contestant A\]\nA-verse-one/);
  assert.match(
    p,
    /Contestant A 6\/10, Contestant B 8\/10\. B had sharper rhymes\./,
  );
  assert.match(p, /playing as Contestant B/);
});

test("feedback from round 1 reaches the round 2 prompt in a full battle", async () => {
  const prompts = [];
  const spy = (id) => ({
    id,
    name: id,
    color: "#fff",
    async *generate({ prompt }) {
      prompts.push(prompt);
      yield "verse";
    },
  });
  const j = {
    id: "j",
    name: "j",
    async *generate() {
      yield '{"a":5,"b":9,"reason":"B won round one"}';
    },
  };
  await runBattle({
    config: { topic: "t", rounds: 2, lines: 4, clean: true },
    fighters: [spy("A"), spy("B")],
    judge: j,
    emit: () => {},
  });
  assert.equal(prompts.length, 4);
  assert.doesNotMatch(prompts[0], /Judge's scores/);
  assert.match(prompts[2], /B won round one/);
});

test("non-English language injects script-specific instruction into fighter and judge prompts", () => {
  const base = {
    topic: "t",
    me: { name: "A" },
    foe: { name: "B" },
    round: 1,
    rounds: 1,
    lines: 4,
    history: [],
    clean: true,
    mode: "rap",
  };
  assert.doesNotMatch(
    versePrompt({ ...base, language: "English" }),
    /Language requirement:/,
  );
  assert.match(
    versePrompt({ ...base, language: "Roman Urdu" }),
    /Language requirement:.*Roman Urdu/,
  );
  assert.match(
    versePrompt({ ...base, language: "Hinglish" }),
    /Language requirement:.*Hinglish/,
  );
  assert.match(
    judgePrompt({
      topic: "t",
      round: 1,
      a: { name: "A", verse: "x" },
      b: { name: "B", verse: "y" },
      mode: "rap",
      language: "Urdu",
    }),
    /The battle is in Urdu/,
  );
});

test("all modes expose 12 unique mainstream topics with explicit roles and compatible defaults", () => {
  const catalog = listModes();
  assert.equal(catalog.length, 5);
  for (const mode of catalog) {
    assert.equal(mode.topics.length, 12);
    assert.equal(new Set(mode.topics.map((t) => t.title)).size, 12);
    assert.ok(mode.topics.some((t) => t.title === mode.topic));
    for (const t of mode.topics) {
      assert.ok(t.title.length <= 200 && t.label && t.a && t.b);
      assert.doesNotMatch(
        t.title,
        /coding|data center|lines of code|tabs.*spaces/i,
      );
    }
  }
});

test("preset roles reach both performers without provider-name anchoring", () => {
  const topic = TOPICS.rap[0];
  const args = {
    topic: topic.title,
    me: { name: "MODEL-SHOULD-NOT-LEAK" },
    foe: { name: "OTHER-MODEL" },
    round: 1,
    rounds: 3,
    lines: 8,
    history: [],
    mode: "rap",
  };
  const a = versePrompt({ ...args, side: "a" });
  const b = versePrompt({ ...args, side: "b" });
  assert.ok(a.includes(`Your role: ${topic.a}`));
  assert.ok(b.includes(`Your role: ${topic.b}`));
  assert.doesNotMatch(a + b, /MODEL-SHOULD-NOT-LEAK|OTHER-MODEL/);
  assert.equal(findTopic("rap", topic.title.toUpperCase()).title, topic.title);
  assert.equal(findTopic("rap", "my own topic"), null);
});

test("performance plans keep different voices and ten unused routes over a five-round battle", () => {
  for (const mode of Object.keys(MODES)) {
    const first = createPerformancePlan(mode, 5, () => 0);
    const second = createPerformancePlan(mode, 5, (n) => n - 1);
    assert.notEqual(first.voices.a, first.voices.b);
    assert.equal(new Set([...first.moves.a, ...first.moves.b]).size, 10);
    assert.notDeepEqual(first, second);
  }
});

test("a full match keeps each voice consistent and changes creative routes each turn", async () => {
  const prompts = { a: [], b: [] };
  const spy = (side) => ({
    id: side,
    name: "Same model",
    async *generate({ prompt }) {
      prompts[side].push(prompt);
      yield "new material";
    },
  });
  await runBattle({
    config: { mode: "rap", topic: TOPICS.rap[0].title, rounds: 3, lines: 8 },
    fighters: [spy("a"), spy("b")],
    emit() {},
  });
  const voices = (side) =>
    prompts[side].map(
      (p) => p.match(/Keep this voice throughout the match: (.+)/)[1],
    );
  assert.equal(new Set(voices("a")).size, 1);
  assert.equal(new Set(voices("b")).size, 1);
  assert.notEqual(voices("a")[0], voices("b")[0]);
  const routes = [...prompts.a, ...prompts.b].map(
    (p) => p.match(/This turn's optional creative route: (.+)/)[1],
  );
  assert.equal(new Set(routes).size, 6);
});

test("only the final story passage resolves the shared conflict; poetry does not demand a rebuttal", () => {
  const args = {
    topic: TOPICS.story[0].title,
    round: 3,
    rounds: 3,
    lines: 6,
    history: [],
    mode: "story",
  };
  assert.doesNotMatch(
    versePrompt({ ...args, side: "a" }),
    /This is the final passage/,
  );
  assert.match(
    versePrompt({ ...args, side: "b" }),
    /This is the final passage/,
  );
  assert.match(
    versePrompt({ ...args, mode: "poetry" }),
    /forced rebuttals.*not required/,
  );
});

test("judge sees prior material for repetition checks and never sees provider names", () => {
  const p = judgePrompt({
    mode: "roast",
    topic: TOPICS.roast[0].title,
    round: 2,
    a: { name: "HIDDEN-PROVIDER", verse: "current A" },
    b: { name: "OTHER-PROVIDER", verse: "current B" },
    history: [{ side: "a", round: 1, verse: "an earlier joke already used" }],
  });
  assert.match(p, /an earlier joke already used/);
  assert.match(p, /do not rescore earlier rounds/);
  assert.doesNotMatch(p, /HIDDEN-PROVIDER|OTHER-PROVIDER/);
});

test("pickVoice assigns distinct voices per corner and detects Urdu/Devanagari scripts", () => {
  assert.notEqual(pickVoice("English", "a"), pickVoice("English", "b"));
  assert.notEqual(pickVoice("Urdu", "a"), pickVoice("Urdu", "b"));
  assert.equal(pickVoice("English", "a", "یہ اردو ہے"), "ur-PK-AsadNeural");
  assert.equal(pickVoice("English", "a", "यह हिंदी है"), "hi-IN-MadhurNeural");
  assert.equal(
    cleanForSpeech('A & B < C > "D"'),
    "A &amp; B &lt; C &gt; &quot;D&quot;",
  );
});

test("withFailover automatically falls back when primary CLI hits quota limit", async () => {
  const broken = {
    id: "claude",
    model: "sonnet",
    name: "Claude",
    async *generate() {
      throw new Error("weekly quota limit reached");
    },
  };
  const backup = {
    id: "antigravity",
    model: "gemini-3.8-flash-high",
    name: "Antigravity",
    async *generate() {
      yield "backup verse delivered";
    },
  };
  const wrapped = withFailover(broken, [broken, backup], "a");
  let out = "";
  for await (const c of wrapped.generate({ prompt: "hi" })) out += c;
  assert.equal(out, "backup verse delivered");
});

test("buildTimelineAndMetadata computes exact startMs/endMs and YouTube chapters", () => {
  const battle = {
    id: "abcd1234",
    config: { mode: "rap", topic: "Coffee vs Tea", language: "English", rounds: 1 },
    fighters: [{ name: "Fighter A" }, { name: "Fighter B" }],
  };
  const segments = [
    { type: "intro", round: 1, durationMs: 2000, text: "Intro" },
    { type: "verse", round: 1, side: "a", durationMs: 4000, text: "Verse A" },
    { type: "verse", round: 1, side: "b", durationMs: 4500, text: "Verse B" },
  ];
  const { timeline, totalDurationMs, youtube } = buildTimelineAndMetadata({ battle, segments });
  assert.equal(timeline.length, 3);
  assert.ok(timeline[1].startMs > timeline[0].endMs);
  assert.ok(totalDurationMs > timeline[2].endMs);
  assert.match(youtube.title, /Fighter A vs Fighter B/);
  assert.match(youtube.shortsTitle, /#Shorts/);
  assert.match(youtube.description, /00:00 Cold Open/);
  assert.ok(getCapabilities().modes.length === 5);
});

test("formatStageName, smartTruncate, and long-topic YouTube metadata preserve #Shorts and deduplicate tags", () => {
  assert.equal(
    formatStageName("Antigravity (Gemini 3.8 Flash (High))"),
    "Gemini 3.8 Flash",
  );
  assert.equal(
    formatStageName("Antigravity (Claude Sonnet 5.5 (High))"),
    "Claude Sonnet 5.5",
  );
  assert.equal(formatStageName("Antigravity (Default)"), "Antigravity");
  assert.ok(smartTruncate("The quick brown fox jumps over the lazy dog", 22).endsWith("…"));

  const battle = {
    id: "d5b00562",
    config: {
      mode: "roast",
      topic: 'The "not ready for a relationship" person vs the ex who found their wedding invite',
      language: "English",
      rounds: 2,
    },
    fighters: [
      { name: "Antigravity (Gemini 3.8 Flash (High))" },
      { name: "Antigravity (Claude Sonnet 5.5 (High))" },
    ],
  };
  const segments = [
    { type: "intro", round: 1, durationMs: 2800, text: "Intro" },
    { type: "verse", round: 1, side: "a", durationMs: 12000, text: "Verse A" },
    { type: "verse", round: 1, side: "b", durationMs: 13000, text: "Verse B" },
  ];
  const shortsSegments = [
    { type: "intro", round: 1, durationMs: 1800, text: "Hook" },
    { type: "verse", round: 1, side: "a", durationMs: 12000, text: "Verse A" },
    { type: "verse", round: 1, side: "b", durationMs: 13000, text: "Verse B" },
    { type: "outro", round: 1, durationMs: 2400, text: "CTA" },
  ];
  const built = buildTimelineAndMetadata({ battle, segments, shortsSegments });
  assert.ok(built.youtube.title.length <= 100);
  assert.ok(built.youtube.shortsTitle.length <= 100);
  assert.ok(
    built.youtube.shortsTitle.endsWith("#Shorts"),
    `Expected #Shorts suffix, got: ${built.youtube.shortsTitle}`,
  );
  assert.match(built.youtube.title, /Gemini 3\.8 Flash vs Claude Sonnet 5\.5/);
  assert.equal(
    built.youtube.tags.length,
    new Set(built.youtube.tags).size,
    "tags should be deduplicated",
  );
  assert.equal(built.shortsTimeline.length, 4);
});

test("cleanVerseText, cleanForSpeech, and getProsody strip markdown and separate corner voices", () => {
  assert.equal(
    cleanVerseText("Holding a *plus-one* invite and **bold** `receipts`."),
    "Holding a plus-one invite and bold receipts.",
  );
  assert.equal(
    cleanForSpeech("A *plus-one* & **bold** line"),
    "A plus-one &amp; bold line",
  );
  const pA = getProsody({ mode: "rap", role: "a", type: "verse" });
  const pB = getProsody({ mode: "rap", role: "b", type: "verse" });
  assert.notEqual(pA.pitch, pB.pitch);
});

test("suddenDeath tiebreaker triggers an extra round when match is tied", async () => {
  let judgeCalls = 0;
  const tiedThenDecisiveJudge = {
    id: "j",
    name: "j",
    async *generate() {
      judgeCalls++;
      if (judgeCalls === 1) yield '{"a": 8, "b": 8, "reason": "Dead even."}';
      else yield '{"a": 8, "b": 9, "reason": "B wins overtime!"}';
    },
  };
  const r = await runBattle({
    config: { topic: "t", rounds: 1, lines: 4, clean: true, suddenDeath: true },
    fighters: [fake("A", "verse A"), fake("B", "verse B")],
    judge: tiedThenDecisiveJudge,
    emit: () => {},
  });
  assert.equal(r.rounds.length, 2);
  assert.equal(r.rounds[1].suddenDeath, true);
  assert.deepEqual(r.totals, { a: 16, b: 17 });
});

test("buildRivalryRoster rotates multiple distinct matchups and synthesizeBattleBedWav produces valid WAV", () => {
  const mockAgy = {
    id: "antigravity",
    name: "Antigravity",
    color: "#22c55e",
    available: () => true,
    models: () => [
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
      { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
      { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
      { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
    ],
    async *generate() {
      yield "ok";
    },
  };
  const roster = buildRivalryRoster([mockAgy]);
  assert.ok(roster.length >= 4);
  assert.notEqual(roster[0][0].name, roster[1][0].name);

  const wav = synthesizeBattleBedWav({
    mode: "rap",
    totalDurationMs: 3000,
    leadInMs: 200,
    timeline: [
      { type: "verse", side: "a", startMs: 300 },
      { type: "verse", side: "b", startMs: 1400 },
      { type: "outro", startMs: 2500 },
    ],
  });
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.ok(wav.length > 100000);
});

test("loadDotEnv, upsertDotEnv, and youtube-login helpers parse Google OAuth JSON and preserve .env comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "botbrawl-env-test-"));
  const envFile = join(dir, ".env");
  const prevId = process.env.YOUTUBE_CLIENT_ID;
  const prevSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const prevRefresh = process.env.YOUTUBE_REFRESH_TOKEN;
  try {
    writeFileSync(envFile, "# Comment preserved\nCUSTOM_FLAG=keep_me\n", "utf8");
    upsertDotEnv(
      {
        YOUTUBE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
        YOUTUBE_CLIENT_SECRET: "GOCSPX-secret",
        YOUTUBE_REFRESH_TOKEN: "1//0refresh-token",
      },
      envFile,
    );
    delete process.env.YOUTUBE_CLIENT_ID;
    delete process.env.YOUTUBE_CLIENT_SECRET;
    delete process.env.YOUTUBE_REFRESH_TOKEN;
    const loaded = loadDotEnv(envFile, { override: true });
    assert.equal(loaded.CUSTOM_FLAG, "keep_me");
    assert.equal(process.env.YOUTUBE_CLIENT_ID, "123-abc.apps.googleusercontent.com");
    assert.equal(process.env.YOUTUBE_REFRESH_TOKEN, "1//0refresh-token");

    const parsed = parseGoogleClientJson(
      JSON.stringify({
        installed: {
          client_id: "999.apps.googleusercontent.com",
          client_secret: "GOCSPX-999",
        },
      }),
    );
    assert.equal(parsed.clientType, "desktop");
    assert.equal(parsed.clientId, "999.apps.googleusercontent.com");
    assert.equal(cleanMacPath("'/Users/mac/Downloads/client_secret.json'"), "/Users/mac/Downloads/client_secret.json");
    assert.equal(cleanMacPath("/Users/mac/Desktop/untitled\\ folder/client_secret.json"), "/Users/mac/Desktop/untitled folder/client_secret.json");
  } finally {
    if (prevId === undefined) delete process.env.YOUTUBE_CLIENT_ID;
    else process.env.YOUTUBE_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.YOUTUBE_CLIENT_SECRET;
    else process.env.YOUTUBE_CLIENT_SECRET = prevSecret;
    if (prevRefresh === undefined) delete process.env.YOUTUBE_REFRESH_TOKEN;
    else process.env.YOUTUBE_REFRESH_TOKEN = prevRefresh;
    rmSync(dir, { recursive: true, force: true });
  }
});

import {
  clamp,
  interpolate,
  spring,
  SPRING_PRESETS,
  dampedShake,
} from "../public/motion-math.js";
import {
  computeHighlightOnset,
  buildCaptionPages,
  measureAlignmentDrift,
  isFunctionWord,
} from "../server/caption-paginator.js";
import {
  splitIntoSpokenLines,
  pickHookPunchline,
  buildBeatGrid,
  buildMasterTimelineV2,
} from "../server/timeline-v2.js";
import { measureAudioMetrics } from "../server/audio-mixer.js";
import { loadBaselineMetrics, generateIterationReportMarkdown } from "../server/video-reviewer.js";

test("motion-math: interpolate, spring dynamics, and capped punchline shake", () => {
  // interpolate
  assert.equal(interpolate(0, [0, 100], [0, 50]), 0);
  assert.equal(interpolate(50, [0, 100], [0, 50]), 25);
  assert.equal(interpolate(120, [0, 100], [0, 50]), 50);

  // spring
  const s0 = spring({ frame: 0, fps: 30, ...SPRING_PRESETS.slam });
  assert.equal(s0, 0);
  const sMid = spring({ frame: 10, fps: 30, ...SPRING_PRESETS.slam });
  assert.ok(sMid > 0.8 && sMid < 1.15, `Expected spring mid-progress around 1, got ${sMid}`);
  const sEnd = spring({ frame: 60, fps: 30, ...SPRING_PRESETS.slam });
  assert.ok(Math.abs(sEnd - 1.0) < 0.01, `Expected settled spring ~1.0, got ${sEnd}`);

  // dampedShake: must be strictly <= 6 frames (default 5) and 0 at/after maxFrames
  const maxFrames = 5;
  for (let f = 0; f < maxFrames; f++) {
    const sh = dampedShake({ frame: f, onsetFrame: 0, maxFrames });
    assert.ok(Number.isFinite(sh.x) && Number.isFinite(sh.y) && Number.isFinite(sh.rotDeg));
  }
  const shAfter = dampedShake({ frame: maxFrames, onsetFrame: 0, maxFrames });
  assert.deepEqual(shAfter, { x: 0, y: 0, rotDeg: 0, scaleBoost: 0 });
});

test("caption-paginator: computeHighlightOnset guarantees 0-2 frame lead and zero lag", () => {
  const fps = 30;
  const frameMs = 1000 / fps; // 33.33ms
  for (let ms = 0; ms < 2000; ms += 7) {
    const hl = computeHighlightOnset(ms, fps, 1);
    const diffMs = ms - hl.highlightStartMs;
    assert.ok(diffMs >= -0.01, `Highlight lagged behind audio at ${ms}ms: diff=${diffMs}`);
    assert.ok(diffMs <= 2.05 * frameMs, `Highlight lead exceeded 2 frames at ${ms}ms: diff=${diffMs}`);
    assert.ok(hl.leadFrames >= -0.001 && hl.leadFrames <= 2.05);
  }
});

test("caption-paginator: partition clause never ends page on avoidable function word", () => {
  assert.equal(isFunctionWord("a"), true);
  assert.equal(isFunctionWord("for"), true);
  assert.equal(isFunctionWord("the"), true);
  assert.equal(isFunctionWord("coat"), false);

  // Baseline line that broke previously: "Lingering off-camera holding my coat while you check for a rental tag’s seam."
  const words = [
    { text: "Lingering", startMs: 100, endMs: 400 },
    { text: "off-camera", startMs: 420, endMs: 820 },
    { text: "holding", startMs: 840, endMs: 1100 },
    { text: "my", startMs: 1120, endMs: 1250 },
    { text: "coat", startMs: 1270, endMs: 1500 },
    { text: "while", startMs: 1530, endMs: 1720 },
    { text: "you", startMs: 1740, endMs: 1880 },
    { text: "check", startMs: 1900, endMs: 2150 },
    { text: "for", startMs: 2170, endMs: 2300 },
    { text: "a", startMs: 2310, endMs: 2420 },
    { text: "rental", startMs: 2440, endMs: 2750 },
    { text: "tag’s", startMs: 2770, endMs: 3000 },
    { text: "seam.", startMs: 3020, endMs: 3300 },
  ];

  const { words: calibrated, pages } = buildCaptionPages(words, { fps: 30, targetLeadFrames: 1 });
  assert.ok(pages.length >= 3 && pages.length <= 5);

  for (const page of pages) {
    const wordCount = page.words.length;
    assert.ok(wordCount >= 2 && wordCount <= 4, `Expected 2-4 words per page, got ${wordCount}: "${page.text}"`);
    assert.equal(
      page.endsOnFunctionWord && !page.functionWordUnavoidable,
      false,
      `Page ended on avoidable function word: "${page.text}"`,
    );
  }

  const drift = measureAlignmentDrift(calibrated, 4000, 30);
  assert.equal(drift.laggingWordCount, 0);
  assert.equal(drift.excessLeadWordCount, 0);
});

test("timeline-v2: buildMasterTimelineV2 enforces hook < 1.5s, max gap <= 2.0s, and non-contradictory ending", () => {
  const battle = {
    id: "test1234",
    config: { mode: "rap", topic: "A fake-rich influencer vs the friend who knows they are broke" },
    fighters: [{ name: "GPT-OSS", stageName: "GPT-OSS" }, { name: "Claude", stageName: "Claude" }],
    totals: { a: 8, b: 10 },
    final: { winner: "b" },
  };

  const lineStems = [
    { id: "hook-0", segmentType: "hook", durationMs: 1200, text: "just to watch other people watch me." },
    { id: "r1-a-l0", segmentType: "verse", round: 1, side: "a", durationMs: 3200, text: "Line 1" },
    { id: "r1-a-l1", segmentType: "verse", round: 1, side: "a", durationMs: 3100, text: "Line 2", isPunchline: true, punchTier: "knockout" },
    { id: "r1-b-l0", segmentType: "verse", round: 1, side: "b", durationMs: 3000, text: "Line 3" },
    { id: "r1-b-l1", segmentType: "verse", round: 1, side: "b", durationMs: 3400, text: "Line 4", isPunchline: true, punchTier: "knockout" },
    { id: "vote-cta-0", segmentType: "vote-cta", durationMs: 1600, text: "Who took it? Vote now!" },
    { id: "outro-0", segmentType: "outro", durationMs: 2200, text: "Claude takes it!", winner: "b", totals: { a: 8, b: 10 } },
  ];

  const tl = buildMasterTimelineV2({ battle, lineStems, fps: 30, maxVisualGapMs: 1750 });
  assert.equal(tl.edition, 2);
  assert.equal(tl.bpm, 90);

  // Hook audible within 1.5s
  const hookLine = tl.lines.find(l => l.segmentType === "hook");
  assert.ok(hookLine && hookLine.startMs < 1500, `Expected hook start < 1500ms, got ${hookLine?.startMs}`);

  // VS Slam <= 1.5s duration
  const vsEv = tl.events.find(e => e.type === "vs-slam");
  assert.ok(vsEv && vsEv.endMs - vsEv.startMs <= 1500);

  // Editorial change interval: verify no visual gap > 2000ms
  const visualEvents = tl.events.filter(e => e.type !== "beat-dropout").sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < visualEvents.length - 1; i++) {
    const gap = visualEvents[i + 1].startMs - visualEvents[i].startMs;
    assert.ok(gap <= 2000, `Visual gap exceeded 2.0s: ${gap}ms between ${visualEvents[i].type} and ${visualEvents[i + 1].type}`);
  }

  // Vote CTA must occur BEFORE Verdict
  const voteEv = tl.events.find(e => e.type === "vote-cta");
  const verdictEv = tl.events.find(e => e.type === "verdict");
  const loopEv = tl.events.find(e => e.type === "loop-bridge");
  assert.ok(voteEv && verdictEv && loopEv);
  assert.ok(voteEv.startMs < verdictEv.startMs, "Vote CTA must precede Winner Verdict");
  assert.ok(verdictEv.startMs < loopEv.startMs, "Verdict must precede Loop Bridge");
});

test("video-reviewer: baseline metrics loader and iteration report markdown generator", () => {
  const base = loadBaselineMetrics();
  assert.equal(base.video.emptyDarkSpacePct, 39.0);
  assert.equal(base.audio.integratedLoudnessLufs, -19.5);

  const mockReport = {
    ok: true,
    videoPath: "/fake/path.mp4",
    totalSec: 44.5,
    checks: {
      hook_audible_under_1_5s: true,
      no_static_over_1s_in_first_5s: true,
      no_visual_gap_over_2s: true,
      zero_lagging_words: true,
      lead_within_0_to_2_frames: true,
      zero_avoidable_function_word_page_ends: true,
      empty_dark_space_under_15_pct: true,
      target_lufs_met: true,
      true_peak_safe: true,
      loudness_range_above_baseline: true,
      final_mix_intelligibility_ge_95: true,
    },
    metrics: {
      maxVisualGapFirst5sSec: 0.72,
      maxVisualGapOverallSec: 1.45,
      meanEmptyDarkSpacePct: 8.4,
      ebur128: { integratedLufs: -14.1, loudnessRangeLu: 6.8, truePeakDbtp: -1.2 },
      whisperIntelligibility: { wordMatchPct: 98.2 },
      avoidableFunctionWordPagesCount: 0,
    },
  };

  const md = generateIterationReportMarkdown({
    iteration: 1,
    battleId: "test1234",
    aspect: "9:16",
    report: mockReport,
    baseline: base,
  });

  assert.match(md, /Attempt: 1/);
  assert.match(md, /Measured checks passed/);
  assert.match(md, /"integratedLufs": -14\.1/);
  assert.match(md, /do not independently measure acoustic synchronization/);
});
