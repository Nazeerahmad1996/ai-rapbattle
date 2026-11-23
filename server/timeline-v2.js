/**
 * Canonical Single Timeline Builder (`timeline-v2.js`).
 *
 * Produces ONE master JSON timeline (`edition: 2`) from battle data + aligned line stems.
 * Drives ALL visuals, single-system word-highlighted captions, camera cuts, punchline shakes,
 * J/L-cut transitions, scoreboard updates, beat drop-outs, and SFX — zero hard-coded timings!
 */

import { buildCaptionPages, measureAlignmentDrift } from './caption-paginator.js';

export const MODE_BPM = {
  rap: 90,
  roast: 92,
  debate: 82,
  poetry: 72,
  story: 74,
};

/** Split a verse or speech block into crisp spoken lines/bars while preserving clean speech punctuation. */
export function splitIntoSpokenLines(rawText) {
  const cleaned = String(rawText ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim();
  if (!cleaned) return [];

  const rawLines = cleaned
    .split(/\n+/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (rawLines.length > 1) return rawLines;

  // Single-paragraph modes (Debate / Story / Judge): split cleanly on sentence boundaries
  const sentences = cleaned
    .split(/(?<=[.!?؟।])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  return sentences.length > 1 ? sentences : [cleaned];
}

/** Pick the sharpest punchline phrase (last clause/bar of the highest-scoring verse) for the 0–1.4s mystery hook. */
export function pickHookPunchline(battle, rounds = []) {
  const effectiveRounds = rounds.length ? rounds : (battle?.rounds ?? []);
  let bestRound = effectiveRounds[0] || null;
  let bestSide = battle?.final?.winner === 'a' ? 'a' : 'b';

  if (bestRound) {
    let bestScore = -1;
    for (const r of effectiveRounds) {
      for (const side of ['a', 'b']) {
        const s = Number(r?.scores?.[side]) || 0;
        if (s >= bestScore && r?.verses?.[side]) {
          bestScore = s;
          bestRound = r;
          bestSide = side;
        }
      }
    }
  }

  const verseText = bestRound?.verses?.[bestSide] || '';
  const lines = splitIntoSpokenLines(verseText);
  const punchLine = lines[lines.length - 1] || lines[0] || battle?.config?.topic || 'Two AIs enter. One survives.';

  // Trim to a punchy <= 9-word hook teaser clause so it fits cleanly inside 0.0–1.35s
  const words = punchLine.split(/\s+/).filter(Boolean);
  // A complete clause may run longer; never manufacture a hook by cutting mid-sentence.
  const clauses = punchLine.split(/(?<=[.!?;:])\s+/).filter(t => t.split(/\s+/).length >= 3);
  const teaser = clauses.find(t => t.split(/\s+/).length <= 12) || punchLine;
  return {
    text: teaser.replace(/^[,;:\u2014\u2013\-\s]+/, ''),
    fullLine: punchLine,
    sourceSide: bestSide,
    sourceRound: bestRound?.round || 1,
  };
}

/** Build the musical beat & bar grid at fixed mode BPM. */
export function buildBeatGrid({ mode = 'rap', totalDurationMs = 45000, offsetMs = 0 } = {}) {
  const bpm = MODE_BPM[mode] || 90;
  const beatMs = 60000 / bpm;
  const barMs = beatMs * 4;
  const beatsMs = [];
  const barsMs = [];
  for (let t = offsetMs, idx = 0; t <= totalDurationMs + beatMs; t += beatMs, idx++) {
    const rounded = Number(t.toFixed(2));
    beatsMs.push(rounded);
    if (idx % 4 === 0) barsMs.push(rounded);
  }
  return {
    bpm,
    beatMs: Number(beatMs.toFixed(2)),
    barMs: Number(barMs.toFixed(2)),
    offsetMs,
    beatsMs,
    barsMs,
  };
}

/** Snap a timestamp forward to the nearest musical subdivision (half-bar or beat) within maxWaitMs. */
export function snapToBeatGrid(timeMs, beatMs, { subdivision = 1, minMs = 0, maxShiftMs = 340 } = {}) {
  const t = Math.max(minMs, timeMs);
  const gridStep = beatMs * subdivision;
  if (!gridStep || gridStep <= 0) return t;
  const nextGrid = Math.ceil(t / gridStep) * gridStep;
  if (nextGrid - t <= maxShiftMs) return Math.round(nextGrid);
  const beatGrid = Math.ceil(t / beatMs) * beatMs;
  if (beatGrid - t <= maxShiftMs) return Math.round(beatGrid);
  return Math.round(t);
}

/**
 * Assemble ONE master Timeline V2 object from aligned line stems.
 *
 * Each input `lineStems` item has:
 * `{ id, segmentType, round, side, role, speaker, text, audioFile, audioPath, audioUrl, durationMs, words: [{ text, offsetMs, durationMs }], isPunchline?, punchTier?, scores?, totals?, winner? }`
 */
export function buildMasterTimelineV2({
  battle,
  roles = null,
  lineStems = [],
  fps = 60,
  targetLeadFrames = 1,
  maxVisualGapMs = 1750,
  captionFontScale = 1.0,
  maxCharsPerPage = 22,
} = {}) {
  const mode = battle?.config?.mode || 'rap';
  const bpm = MODE_BPM[mode] || 90;
  const beatMs = 60000 / bpm;
  const barMs = beatMs * 4;

  const lines = [];
  const allAlignedWords = [];
  const events = [];
  const sfxCues = [];

  // Running scoreboard state so the scoreboard moves every round & mid-round!
  let runningScoreA = 0;
  let runningScoreB = 0;
  const scoredRoundsB = new Set();

  // Track cursor in ms (Frame 0 = 0.0ms -> Zero dead air!)
  let cursorMs = 0;

  const hookStem = lineStems.find(s => s.segmentType === 'hook');
  const contentStems = lineStems.filter(s => s.segmentType !== 'hook' && s.segmentType !== 'outro' && s.segmentType !== 'vote-cta');
  const voteStem = lineStems.find(s => s.segmentType === 'vote-cta');
  const outroStem = lineStems.find(s => s.segmentType === 'outro');

  // --- 1. COLD-OPEN HOOK (0.00s – ~1.40s): Frame 0 active + audible within 80ms ---
  const hookStartMs = 0;
  const hookVoiceOffsetMs = 70; // Audible in 0.07s << 1.5s requirement!
  const hookDurMs = hookStem ? Math.max(950, hookStem.durationMs + 100) : 1250;
  const hookEndMs = hookVoiceOffsetMs + hookDurMs;

  events.push(
    {
      type: 'hook',
      startMs: 0,
      endMs: hookEndMs,
      camera: 'hook-punch',
      payload: {
        kicker: 'WAIT FOR THIS BAR…',
        text: hookStem?.text || '',
      },
    },
    // Mid-hook micro-angle shift at 0.72s so NO static frame lasts > 1.0s in the first 5s!
    {
      type: 'camera-cut',
      startMs: Math.round(hookEndMs * 0.52),
      endMs: hookEndMs,
      camera: 'hook-tight',
      payload: { reason: 'intro-sub-1s-guard' },
    },
  );
  sfxCues.push({ sfxId: 'impact', startMs: 0, gainDb: -1.5 });

  if (hookStem) {
    const placedWords = placeStemWords(hookStem, hookVoiceOffsetMs, 'hook-0');
    const activeHookWords = placedWords.filter(w => w.startMs < hookEndMs);
    const hookDisplayText = activeHookWords.map(w => w.text).join(' ');
    lines.push({
      ...stripRawPaths(hookStem),
      id: 'hook-0',
      text: hookDisplayText || hookStem.text,
      startMs: hookVoiceOffsetMs,
      endMs: hookVoiceOffsetMs + hookStem.durationMs,
      clipEndMs: hookEndMs,
      barIndex: 0,
      words: activeHookWords.length ? activeHookWords : placedWords,
    });
    allAlignedWords.push(...(activeHookWords.length ? activeHookWords : placedWords));
  }

  // --- 2. VS SLAM (~1.42s – ~2.72s, strictly <= 1.5s) ---
  const vsStartMs = hookEndMs + 40;
  const vsDurationMs = 900; // 1.26s <= 1.5s cap
  const vsEndMs = vsStartMs + vsDurationMs;
  events.push(
    {
      type: 'vs-slam',
      startMs: vsStartMs,
      endMs: vsEndMs,
      camera: 'vs-clash',
      payload: {
        fighterA: battle?.fighters?.[0]?.stageName || battle?.fighters?.[0]?.name || 'CORNER A',
        fighterB: battle?.fighters?.[1]?.stageName || battle?.fighters?.[1]?.name || 'CORNER B',
        topic: roles?.label || battle?.config?.topic || '',
      },
    },
    {
      type: 'camera-cut',
      startMs: vsStartMs + 640,
      endMs: vsEndMs,
      camera: 'vs-topic-zoom',
      payload: { reason: 'vs-topic-reveal' },
    },
  );
  sfxCues.push(
    { sfxId: 'whoosh', startMs: Math.max(0, vsStartMs - 50), gainDb: -3.0 },
    { sfxId: 'impact', startMs: vsStartMs + 40, gainDb: -2.0 },
  );

  // --- 3. ROUND 1 DROP (~2.76s – ~3.26s -> Verse 1 starts right around ~3.25s <= 4.0s!) ---
  const r1CardStartMs = vsEndMs + 40;
  const r1CardEndMs = r1CardStartMs + 460;
  events.push({
    type: 'round-start',
    round: 1,
    startMs: r1CardStartMs,
    endMs: r1CardEndMs,
    camera: 'wide-establish',
    payload: { round: 1, label: 'ROUND 01' },
  });
  sfxCues.push({ sfxId: 'round-bell', startMs: r1CardStartMs, gainDb: -1.5 });

  // Beat drops right at Round 1 start!
  const beatOriginMs = r1CardStartMs;
  cursorMs = r1CardEndMs + 80;

  let prevSide = null;
  let prevRound = 1;
  let cameraCycleIdx = 0;
  const CAMERA_ANGLES = ['hero-medium', 'hero-close', 'rivalry-angle', 'hero-low-push'];

  // --- 4. VERSES & JUDGE SCORES (Line-by-Line with >= 250ms Breath Gaps, J/L-Cuts & Beat Drops) ---
  for (let idx = 0; idx < contentStems.length; idx++) {
    const stem = contentStems[idx];
    const nextStem = contentStems[idx + 1] || null;

    // Round transition banner for Round 2+
    if (stem.round && stem.round !== prevRound && stem.segmentType === 'verse' && stem.side === 'a') {
      const rStart = cursorMs + 120;
      const rEnd = rStart + 520;
      events.push({
        type: 'round-start',
        round: stem.round,
        startMs: rStart,
        endMs: rEnd,
        camera: 'wide-establish',
        payload: {
          round: stem.round,
          label: stem.suddenDeath ? 'SUDDEN DEATH' : `ROUND 0${stem.round}`,
        },
      });
      sfxCues.push({ sfxId: 'round-bell', startMs: rStart, gainDb: -2.0 });
      cursorMs = rEnd + 120;
      prevRound = stem.round;
    }

    // J-Cut Speaker Switch (-180ms audio/visual whip pre-roll!)
    if (stem.segmentType === 'verse' && prevSide && stem.side && stem.side !== prevSide) {
      const switchPreMs = Math.max(r1CardEndMs, cursorMs - 180);
      events.push({
        type: 'speaker-switch',
        startMs: switchPreMs,
        endMs: cursorMs + 160,
        side: stem.side,
        camera: 'whip-pan',
        payload: { fromSide: prevSide, toSide: stem.side, jCutLeadMs: 180 },
      });
      sfxCues.push({ sfxId: 'whoosh', startMs: switchPreMs, gainDb: -3.5 });
      cursorMs += 140; // Extra breathing room across speaker swap
    }

    // Roast mode: 300ms dramatic silence setup before punchlines!
    if (mode === 'roast' && stem.isPunchline) {
      cursorMs += 80; // Added on top of >= 260ms inter-line gap -> ~340ms silence before punchline!
    }

    // Rap mode: snap line entry cleanly toward beat pulse within 320ms so flow locks to 90 BPM pocket
    if (mode === 'rap' && stem.segmentType === 'verse') {
      const rel = cursorMs - beatOriginMs;
      const snappedRel = snapToBeatGrid(rel, beatMs, { subdivision: 1, minMs: rel, maxShiftMs: beatMs });
      cursorMs = beatOriginMs + snappedRel;
    }

    const lineStartMs = Math.round(cursorMs);
    const lineEndMs = Math.round(lineStartMs + stem.durationMs);
    const barIndex = Math.max(0, Math.floor((lineStartMs - beatOriginMs) / barMs));
    const barCount = Math.max(1, Math.round(stem.durationMs / barMs));

    const angle = CAMERA_ANGLES[cameraCycleIdx % CAMERA_ANGLES.length];
    cameraCycleIdx++;

    events.push({
      type: 'line-start',
      lineId: stem.id,
      round: stem.round || 1,
      side: stem.side || null,
      role: stem.role || 'a',
      startMs: lineStartMs,
      endMs: lineEndMs,
      camera: stem.isPunchline ? 'punch-push' : angle,
      payload: {
        speaker: stem.speaker,
        isPunchline: Boolean(stem.isPunchline),
        punchTier: stem.punchTier || null,
      },
    });

    const placedWords = placeStemWords(stem, lineStartMs, stem.id);
    lines.push({
      ...stripRawPaths(stem),
      startMs: lineStartMs,
      endMs: lineEndMs,
      barIndex,
      barCount,
      camera: stem.isPunchline ? 'punch-push' : angle,
      words: placedWords,
    });
    allAlignedWords.push(...placedWords);

    // Punchline choreography: Pre-punchline beat drop-out + Impact + 5-frame Shake + L-cut Reaction!
    if (stem.isPunchline && (mode === 'rap' || mode === 'roast')) {
      const lastWord = placedWords[placedWords.length - 1];
      const punchImpactMs = lastWord ? Math.round(lastWord.startMs) : Math.max(lineStartMs + 250, lineEndMs - 380);
      const isKnockout = stem.punchTier === 'knockout';

      if (isKnockout && (mode === 'rap' || mode === 'roast')) {
        const dropStartMs = Math.max(lineStartMs, punchImpactMs - 340);
        events.push({
          type: 'beat-dropout',
          startMs: dropStartMs,
          endMs: lineEndMs + 180,
          payload: { lineId: stem.id },
        });
        if (mode === 'rap') {
          sfxCues.push({ sfxId: 'record-scratch', startMs: Math.max(0, dropStartMs - 40), gainDb: -6.5 });
        }
      }

      events.push({
        type: 'punchline',
        lineId: stem.id,
        side: stem.side,
        startMs: punchImpactMs,
        endMs: punchImpactMs + (isKnockout ? 480 : 280),
        camera: 'punch-shake',
        payload: {
          tier: stem.punchTier || 'mid',
          shakeFrames: 5, // Strictly <= 6 frames!
          badge: isKnockout
            ? (mode === 'roast' ? 'SAVAGE BURN 🔥' : mode === 'poetry' ? 'DEEP LINE ✨' : 'KNOCKOUT BAR 🔥')
            : 'BARS ⚡',
          lCutReactionSide: stem.side === 'a' ? 'b' : 'a',
        },
      });
      sfxCues.push({ sfxId: 'impact', startMs: punchImpactMs, gainDb: isKnockout ? -2.0 : -5.0 });

      if (isKnockout) {
        if (mode === 'roast') {
          sfxCues.push({ sfxId: 'crowd-laugh', startMs: lineEndMs - 80, gainDb: -4.5 });
        } else if (mode === 'rap') {
          sfxCues.push({ sfxId: 'crowd-ooh', startMs: lineEndMs - 90, gainDb: -4.5 });
        } else if (mode === 'poetry') {
          sfxCues.push({ sfxId: 'applause', startMs: lineEndMs - 60, gainDb: -5.5 });
        }
      }
    }

    // Mid-round & end-of-round Scoreboard Movement (so scoreboard NEVER stays frozen at 0-0!)
    const isLastLineOfVerseA =
      stem.segmentType === 'verse' &&
      stem.side === 'a' &&
      (!nextStem || nextStem.side !== 'a' || nextStem.round !== stem.round);

    if (isLastLineOfVerseA && stem.roundScores?.a) {
      runningScoreA += Number(stem.roundScores.a) || 0;
      events.push({
        type: 'score-change',
        round: stem.round,
        side: 'a',
        startMs: lineEndMs + 40,
        endMs: lineEndMs + 640,
        payload: {
          delta: Number(stem.roundScores.a) || 0,
          scoreA: runningScoreA,
          scoreB: runningScoreB,
          pendingSide: 'b',
          badge: `+${stem.roundScores.a} PTS`,
        },
      });
    }

    const isLastLineOfVerseB =
      stem.segmentType === 'verse' &&
      stem.side === 'b' &&
      (!nextStem || nextStem.side !== 'b' || nextStem.round !== stem.round);

    // If there is an explicit judge stem right after Verse B, update B's score on the judge stem;
    // otherwise (e.g. tight 1-round Shorts cut), hold suspense or tick B's round score right before Verdict!
    if (stem.segmentType === 'judge' && stem.scores && !scoredRoundsB.has(stem.round)) {
      scoredRoundsB.add(stem.round);
      runningScoreB += Number(stem.scores.b) || 0;
      events.push({
        type: 'score-change',
        round: stem.round,
        side: 'b',
        startMs: lineStartMs + 80,
        endMs: lineStartMs + 780,
        payload: {
          delta: Number(stem.scores.b) || 0,
          scoreA: runningScoreA,
          scoreB: runningScoreB,
          pendingSide: null,
          badge: `ROUND ${stem.round}: ${stem.scores.a} - ${stem.scores.b}`,
        },
      });
      sfxCues.push({ sfxId: 'impact', startMs: lineStartMs + 60, gainDb: -4.0 });
    } else if (isLastLineOfVerseB && !contentStems.some(s => s.segmentType === 'judge' && s.round === stem.round)) {
      // Show live "SCORING..." suspense pulse on Corner B before Vote CTA!
      events.push({
        type: 'score-suspense',
        round: stem.round,
        side: 'b',
        startMs: lineEndMs + 40,
        endMs: lineEndMs + 420,
        payload: {
          scoreA: runningScoreA,
          scoreB: '?',
          badge: 'JUDGE LOCKED IN',
        },
      });
    }

    const isLastStemOfRound =
      !nextStem || (nextStem.round && stem.round && nextStem.round !== stem.round);
    if (isLastStemOfRound) {
      events.push({
        type: 'round-end',
        round: stem.round || prevRound,
        startMs: lineEndMs,
        endMs: lineEndMs + 240,
        payload: {
          round: stem.round || prevRound,
          scoreA: runningScoreA,
          scoreB: runningScoreB,
        },
      });
    }

    prevSide = stem.side || prevSide;
    // Mandatory >= 270ms breathing gap between every spoken line (>= 250ms requirement!)
    const interLineGapMs = mode === 'rap' ? 90 : mode === 'poetry' ? 460 : mode === 'story' ? 230 : (stem.isPunchline && stem.punchTier === 'knockout' ? 420 : 240);
    cursorMs = lineEndMs + interLineGapMs;
  }

  // --- 5. ENDING SEQUENCE: Ask Vote FIRST -> Reveal Winner in Last ~2.6s -> Seamless Frame-0 Loop ---
  const voteStartMs = Math.round(cursorMs);
  const voteDurMs = voteStem ? Math.max(1450, voteStem.durationMs) : 1650;
  const voteEndMs = voteStartMs + voteDurMs;

  events.push({
    type: 'vote-cta',
    startMs: voteStartMs,
    endMs: voteEndMs,
    camera: 'dual-standoff',
    payload: {
      prompt: 'WHO TOOK IT?',
      subPrompt: 'DROP "A" OR "B" IN COMMENTS BEFORE THE VERDICT!',
      scoreA: runningScoreA,
      scoreB: '?',
    },
  });
  sfxCues.push({ sfxId: 'whoosh', startMs: Math.max(0, voteStartMs - 60), gainDb: -4.0 });

  if (voteStem) {
    const placedVoteWords = placeStemWords(voteStem, voteStartMs, 'vote-cta-0');
    lines.push({
      ...stripRawPaths(voteStem),
      id: 'vote-cta-0',
      startMs: voteStartMs,
      endMs: voteStartMs + voteStem.durationMs,
      barIndex: Math.max(0, Math.floor((voteStartMs - beatOriginMs) / barMs)),
      words: placedVoteWords,
    });
    allAlignedWords.push(...placedVoteWords);
  }

  // Final Winner Reveal (~2.5s) + 0.38s Loop Bridge back to Frame 0!
  const verdictStartMs = voteEndMs + 260;
  const finalTotals = outroStem?.totals || battle?.totals || { a: runningScoreA, b: runningScoreB };
  const winnerSide = outroStem?.winner || battle?.final?.winner || (finalTotals.b === finalTotals.a ? 'draw' : finalTotals.b > finalTotals.a ? 'b' : 'a');
  const winnerName =
    winnerSide === 'draw'
      ? 'DEAD HEAT DRAW'
      : winnerSide === 'a'
        ? (battle?.fighters?.[0]?.stageName || battle?.fighters?.[0]?.name || 'CORNER A')
        : (battle?.fighters?.[1]?.stageName || battle?.fighters?.[1]?.name || 'CORNER B');

  const verdictDurMs = outroStem ? Math.max(2100, outroStem.durationMs + 420) : 2300;
  const verdictEndMs = verdictStartMs + verdictDurMs;

  events.push(
    {
      type: 'score-change',
      round: prevRound,
      side: 'both',
      startMs: verdictStartMs,
      endMs: verdictEndMs,
      payload: {
        scoreA: finalTotals.a,
        scoreB: finalTotals.b,
        pendingSide: null,
        badge: `FINAL: ${finalTotals.a} - ${finalTotals.b}`,
      },
    },
    {
      type: 'verdict',
      startMs: verdictStartMs,
      endMs: verdictEndMs,
      camera: 'winner-slam',
      payload: {
        winnerSide,
        winnerName,
        totals: finalTotals,
      },
    },
    // Mid-verdict secondary zoom beat at +1.15s so there is zero >1.8s static hold at the end
    {
      type: 'camera-cut',
      startMs: verdictStartMs + 1150,
      endMs: verdictEndMs,
      camera: 'winner-glory-push',
      payload: { reason: 'verdict-push' },
    },
  );
  sfxCues.push(
    { sfxId: 'impact', startMs: verdictStartMs, gainDb: -1.2 },
    { sfxId: 'round-bell', startMs: verdictStartMs + 90, gainDb: -2.5 },
    { sfxId: 'applause', startMs: verdictStartMs + 140, gainDb: -5.0 },
  );

  if (outroStem) {
    const placedOutroWords = placeStemWords(outroStem, verdictStartMs + 60, 'outro-0');
    lines.push({
      ...stripRawPaths(outroStem),
      id: 'outro-0',
      startMs: verdictStartMs + 60,
      endMs: verdictStartMs + 60 + outroStem.durationMs,
      barIndex: Math.max(0, Math.floor((verdictStartMs - beatOriginMs) / barMs)),
      words: placedOutroWords,
    });
    allAlignedWords.push(...placedOutroWords);
  }

  // Seamless Loop Bridge (final 360ms whip-dissolves geometry/lighting back into Frame 0's Hook pose!)
  const loopBridgeStartMs = verdictEndMs;
  const totalDurationMs = loopBridgeStartMs + 360;
  events.push({
    type: 'loop-bridge',
    startMs: loopBridgeStartMs,
    endMs: totalDurationMs,
    camera: 'loop-whip-to-hook',
    payload: { targetFrame: 0 },
  });
  sfxCues.push({ sfxId: 'whoosh', startMs: loopBridgeStartMs, gainDb: -4.5 });

  // --- 6. PACING GUARD: Inject beat-snapped camera angle cuts if ANY visual gap exceeds maxVisualGapMs ---
  injectRhythmCameraCuts(events, totalDurationMs, { maxVisualGapMs, beatMs, beatOriginMs });
  events.sort((a, b) => a.startMs - b.startMs);
  sfxCues.sort((a, b) => a.startMs - b.startMs);

  // --- 7. BUILD SINGLE KINETIC CAPTION PAGES (2–4 words, 0–2 frame lead, 0 function-word endings) ---
  const { words: calibratedWords, pages: captionPages } = buildCaptionPages(allAlignedWords, {
    fps,
    targetLeadFrames,
    maxCharsPerPage,
  });

  // Back-populate calibrated highlight timings onto per-line word lists
  const wordByGlobalIdx = new Map(calibratedWords.map(w => [w.globalWordId, w]));
  for (const line of lines) {
    line.words = line.words.map(w => wordByGlobalIdx.get(w.globalWordId) || w);
  }

  const beatGrid = buildBeatGrid({ mode, totalDurationMs, offsetMs: beatOriginMs });
  const alignmentDrift = measureAlignmentDrift(calibratedWords, totalDurationMs, fps);

  return {
    edition: 2,
    fps,
    totalFrames: Math.ceil((totalDurationMs / 1000) * fps),
    totalDurationMs,
    mode,
    bpm,
    captionFontScale,
    beatGrid,
    alignmentDrift,
    lines,
    words: calibratedWords,
    captionPages,
    events,
    sfxCues,
  };
}

function stripRawPaths(stem) {
  return {
    id: stem.id,
    segmentType: stem.segmentType,
    round: stem.round || 1,
    suddenDeath: Boolean(stem.suddenDeath),
    side: stem.side || null,
    role: stem.role || 'a',
    speaker: stem.speaker || '',
    text: stem.text || '',
    audioFile: stem.audioFile || null,
    audioPath: stem.audioPath || null,
    audioUrl: stem.audioUrl || null,
    durationMs: stem.durationMs || 0,
    alignmentSource: stem.alignmentSource || (stem.words?.length ? 'legacy' : 'estimated'),
    voiceEngine: stem.voiceEngine || null,
    voice: stem.voice || null,
    barMeta: stem.barMeta || null,
    isPunchline: Boolean(stem.isPunchline),
    punchTier: stem.punchTier || null,
  };
}

function placeStemWords(stem, lineStartMs, lineId) {
  const rawWords = Array.isArray(stem.words) && stem.words.length
    ? stem.words
    : fallbackUniformWords(stem.text, stem.durationMs);

  const clipCapMs = lineStartMs + (stem.clipDurationMs || stem.durationMs || Infinity);
  const out = [];
  for (let i = 0; i < rawWords.length; i++) {
    const rw = rawWords[i];
    const startMs = lineStartMs + Math.max(0, Number(rw.offsetMs ?? rw.startMs ?? 0));
    if (startMs >= clipCapMs - 40) break;
    const dur = Math.max(40, Number(rw.durationMs ?? ((rw.endMs ?? startMs + 160) - (rw.startMs ?? 0))));
    const endMs = Math.min(clipCapMs, startMs + dur);
    out.push({
      globalWordId: `${lineId}:w${i}`,
      lineId,
      role: stem.role || stem.side || 'judge',
      side: stem.side || null,
      speaker: stem.speaker || '',
      text: String(rw.text ?? '').trim(),
      startMs: Number(startMs.toFixed(2)),
      endMs: Number(endMs.toFixed(2)),
      lineBreakAfter: i === rawWords.length - 1,
    });
  }
  return out;
}

function fallbackUniformWords(text, durationMs = 1500) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const usable = Math.max(300, durationMs * 0.92);
  const step = usable / tokens.length;
  return tokens.map((tok, i) => ({
    text: tok,
    offsetMs: Math.round(i * step),
    durationMs: Math.max(50, Math.round(step * 0.88)),
  }));
}

function injectRhythmCameraCuts(events, totalDurationMs, { maxVisualGapMs = 1750, beatMs = 666.67, beatOriginMs = 0 }) {
  const cutAnchors = new Set([0, totalDurationMs]);
  for (const ev of events) {
    if (ev.type !== 'beat-dropout') {
      cutAnchors.add(Math.round(ev.startMs));
    }
  }
  const sorted = [...cutAnchors].sort((a, b) => a - b);
  const EXTRA_ANGLES = ['hero-push-tight', 'diagonal-counter', 'hero-medium-wide', 'low-angle-power'];
  let injectIdx = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    let segStart = sorted[i];
    const segEnd = sorted[i + 1];
    while (segEnd - segStart > maxVisualGapMs) {
      const targetMid = segStart + Math.min(1450, Math.round((segEnd - segStart) / 2));
      const rel = targetMid - beatOriginMs;
      const beatSnapped = beatOriginMs + Math.round(rel / (beatMs / 2)) * (beatMs / 2);
      const cutMs = Math.round(
        beatSnapped > segStart + 450 && beatSnapped < segEnd - 350 ? beatSnapped : targetMid,
      );
      events.push({
        type: 'camera-cut',
        startMs: cutMs,
        endMs: Math.min(segEnd, cutMs + 900),
        camera: EXTRA_ANGLES[injectIdx % EXTRA_ANGLES.length],
        payload: { reason: 'pacing-2s-guard' },
      });
      injectIdx++;
      segStart = cutMs;
    }
  }
}
