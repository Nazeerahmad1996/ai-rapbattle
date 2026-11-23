/**
 * Single Kinetic Caption Paginator & Frame-Exact Word Highlight Scheduler.
 *
 * Enforces:
 * 1. One caption system only: 2–4 words per page (1 word only when forced by hard punctuation/pause).
 * 2. Splits cleanly on clause/sentence punctuation, explicit bar breaks, and pauses >= 180ms.
 * 3. Dynamic-programming clause partitioner that forbids ending pages on function words
 *    (a, an, the, to, for, of, in, on, with, and, but, etc.) unless unavoidable at clause end.
 * 4. Frame-quantized global highlight lead so highlight onset is ALWAYS 0–2 frames ahead
 *    of aligned audio word onset, NEVER lagging (> 0 frames late).
 */

export const FUNCTION_WORDS = new Set([
  'a', 'an', 'the',
  'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'onto', 'upon', 'than', 'as',
  'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'while', 'when', 'that', 'who', 'which', 'whose',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'is', 'am', 'are', 'was', 'were', 'be', 'been',
]);

const HARD_PUNCT_RE = /[.!?؟।,;:\u2014\u2013]+["'”’)\]]*$/;

export function normalizeWordToken(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/^[^a-z0-9\u0600-\u06FF\u0900-\u097F]+|[^a-z0-9\u0600-\u06FF\u0900-\u097F]+$/gi, '');
}

export function isFunctionWord(rawWord) {
  const norm = normalizeWordToken(rawWord);
  return Boolean(norm && FUNCTION_WORDS.has(norm));
}

export function hasClauseEndingPunct(rawWord) {
  return HARD_PUNCT_RE.test(String(rawWord ?? '').trim());
}

/**
 * Compute a highlight start frame at the requested export frame rate so `0.0 <= (wordStartMs - highlightMs) <= 2.0 frames`.
 * Never highlights AFTER `wordStartMs`.
 */
export function computeHighlightOnset(wordStartMs, fps = 30, targetLeadFrames = 1, minFrame = 0) {
  const frameMs = 1000 / fps;
  const safeStart = Math.max(0, Number(wordStartMs) || 0);
  // Latest frame whose timestamp `f * frameMs <= safeStart`
  const latestNotAfterFrame = Math.max(0, Math.floor((safeStart + 0.001) / frameMs));
  let frame = Math.max(minFrame, latestNotAfterFrame - targetLeadFrames);

  // Never lead by more than 2.0 frames
  while (safeStart - frame * frameMs > 2.0 * frameMs + 0.05 && frame < latestNotAfterFrame) {
    frame++;
  }
  // Never lag behind safeStart
  if (frame * frameMs > safeStart + 0.05) {
    frame = latestNotAfterFrame;
  }
  frame = Math.max(0, frame);
  return {
    highlightFrame: frame,
    highlightStartMs: Number((frame * frameMs).toFixed(2)),
    leadFrames: Number(((safeStart - frame * frameMs) / frameMs).toFixed(3)),
  };
}

/**
 * Partition a contiguous clause of words (between hard punctuation / pause breaks)
 * into optimal 2–4 word pages using dynamic programming.
 */
function partitionClauseIntoPages(clauseWords, { maxCharsPerPage = 23 } = {}) {
  const n = clauseWords.length;
  if (n === 0) return [];
  if (n <= 3) {
    const joined = clauseWords.map(w => w.text).join(' ');
    if (joined.length <= maxCharsPerPage + 4 || n <= 2) {
      return [clauseWords];
    }
  }

  const INF = 1e9;
  const dp = new Array(n + 1).fill(INF);
  const nextJump = new Array(n + 1).fill(1);
  dp[n] = 0;

  for (let i = n - 1; i >= 0; i--) {
    for (let len = 1; len <= 4 && i + len <= n; len++) {
      const slice = clauseWords.slice(i, i + len);
      const isClauseEnd = i + len === n;
      const lastWord = slice[slice.length - 1];
      const charCount = slice.map(w => w.text).join(' ').length;

      let cost = 0;
      // Page word-count preference: 3 words ideal, 2 or 4 great, 1 word heavily discouraged unless unavoidable
      if (len === 3) cost += 0;
      else if (len === 2) cost += 1.2;
      else if (len === 4) cost += 2.2;
      else if (len === 1) cost += n === 1 ? 0 : 38;

      // Keep lines punchy and readable at 72-84px on a 1080px phone screen
      if (charCount > maxCharsPerPage) {
        cost += (charCount - maxCharsPerPage) * 5;
      }
      if (charCount > maxCharsPerPage + 7 && len > 1) {
        cost += 220;
      }

      // CRITICAL RULE: Avoid ending a page on a function word unless it is the true end of the clause
      if (!isClauseEnd && isFunctionWord(lastWord.text)) {
        cost += 500;
      }

      // Bonus for breaking right before a minor acoustic gap (>= 90ms)
      if (!isClauseEnd) {
        const nextWord = clauseWords[i + len];
        const gapMs = (Number(nextWord.startMs) || 0) - (Number(lastWord.endMs) || 0);
        if (gapMs >= 90) cost -= 2.5;
      }

      const total = cost + dp[i + len];
      if (total < dp[i]) {
        dp[i] = total;
        nextJump[i] = len;
      }
    }
  }

  const pages = [];
  let cursor = 0;
  while (cursor < n) {
    const step = nextJump[cursor] || Math.min(3, n - cursor);
    pages.push(clauseWords.slice(cursor, cursor + step));
    cursor += step;
  }
  return pages;
}

/**
 * Given aligned words `[{ text, startMs, endMs, lineIndex?, speaker?, role? }]`,
 * apply calibrated frame-lead timing and paginate into crisp 2–4 word pages.
 */
export function buildCaptionPages(
  rawWords,
  {
    fps = 30,
    targetLeadFrames = 1,
    pauseSplitMs = 180,
    maxCharsPerPage = 23,
    pageHoldTailMs = 140,
  } = {},
) {
  if (!Array.isArray(rawWords) || rawWords.length === 0) {
    return { words: [], pages: [] };
  }

  // 1. Calibrate highlight onset per word (0–2 frames ahead, never late, monotonically non-decreasing)
  let prevHighlightFrame = 0;
  const words = rawWords.map((w, idx) => {
    const startMs = Math.max(0, Number(w.startMs) || 0);
    const endMs = Math.max(startMs + 35, Number(w.endMs) || startMs + 140);
    const onset = computeHighlightOnset(startMs, fps, targetLeadFrames, prevHighlightFrame);
    // Notice: if onset had to clamp up to prevHighlightFrame, make sure it still NEVER exceeds startMs!
    const frameMs = 1000 / fps;
    let hlFrame = onset.highlightFrame;
    const latestValid = Math.max(0, Math.floor((startMs + 0.001) / frameMs));
    if (hlFrame > latestValid) hlFrame = latestValid;
    prevHighlightFrame = hlFrame;

    return {
      ...w,
      index: idx,
      text: String(w.text ?? '').trim(),
      startMs: Number(startMs.toFixed(2)),
      endMs: Number(endMs.toFixed(2)),
      highlightFrame: hlFrame,
      highlightStartMs: Number((hlFrame * frameMs).toFixed(2)),
      leadFrames: Number(((startMs - hlFrame * frameMs) / frameMs).toFixed(3)),
    };
  }).filter(w => w.text.length > 0);

  const frameMs = 1000 / fps;
  for (let i = 0; i < words.length; i++) {
    const nextHlFrame = i + 1 < words.length ? words[i + 1].highlightFrame : Infinity;
    const rawHoldEndFrame = Math.ceil((words[i].endMs + 90) / frameMs);
    const hlEndFrame = Math.max(
      words[i].highlightFrame + 1,
      Math.min(rawHoldEndFrame, nextHlFrame),
    );
    words[i].highlightEndFrame = hlEndFrame;
    words[i].highlightEndMs = Number((hlEndFrame * frameMs).toFixed(2));
  }

  // 2. Split words into natural clauses on punctuation, pauses >= pauseSplitMs, speaker switches, or bar linebreaks
  const clauses = [];
  let currentClause = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    currentClause.push(w);
    const next = words[i + 1];
    if (!next) {
      clauses.push(currentClause);
      currentClause = [];
      continue;
    }
    const pauseGap = next.startMs - w.endMs;
    const speakerChanged = w.role !== next.role || w.speaker !== next.speaker;
    const lineChanged = w.lineId !== undefined && next.lineId !== undefined && w.lineId !== next.lineId;
    if (
      speakerChanged ||
      lineChanged ||
      hasClauseEndingPunct(w.text) ||
      w.lineBreakAfter ||
      pauseGap >= pauseSplitMs
    ) {
      clauses.push(currentClause);
      currentClause = [];
    }
  }
  if (currentClause.length) clauses.push(currentClause);

  // 3. DP-partition each clause into 2–4 word pages avoiding trailing function words
  const rawPageWordGroups = [];
  for (const clause of clauses) {
    const partitioned = partitionClauseIntoPages(clause, { maxCharsPerPage });
    rawPageWordGroups.push(...partitioned);
  }

  // 4. Assign non-overlapping integer [startFrame, endFrame) & [startMs, endMs] windows per page
  const pages = rawPageWordGroups.map((group, pIdx) => {
    const first = group[0];
    const last = group[group.length - 1];
    const nextGroupFirst = rawPageWordGroups[pIdx + 1]?.[0] ?? null;
    const startFrame = first.highlightFrame;
    const rawEndFrame = Math.max(last.highlightEndFrame, Math.ceil((last.endMs + pageHoldTailMs) / frameMs));
    const endFrame = nextGroupFirst
      ? Math.max(startFrame + 1, Math.min(rawEndFrame, nextGroupFirst.highlightFrame))
      : Math.max(startFrame + 2, rawEndFrame);
    const startMs = startFrame * frameMs;
    const endMs = endFrame * frameMs;

    const lastIsFunc = isFunctionWord(last.text);
    const nextIsDifferentClause =
      !nextGroupFirst ||
      hasClauseEndingPunct(last.text) ||
      last.lineBreakAfter ||
      (last.lineId !== undefined && last.lineId !== nextGroupFirst.lineId) ||
      last.role !== nextGroupFirst.role ||
      nextGroupFirst.startMs - last.endMs >= pauseSplitMs;

    return {
      index: pIdx,
      role: first.role || 'a',
      speaker: first.speaker || '',
      lineId: first.lineId ?? null,
      startFrame,
      endFrame,
      startMs: Number(startMs.toFixed(2)),
      endMs: Number(Math.max(startMs + 60, endMs).toFixed(2)),
      text: group.map(w => w.text).join(' '),
      endsOnFunctionWord: lastIsFunc,
      functionWordUnavoidable: lastIsFunc && nextIsDifferentClause,
      words: group.map(w => ({
        index: w.index,
        text: w.text,
        startMs: w.startMs,
        endMs: w.endMs,
        highlightFrame: w.highlightFrame,
        highlightEndFrame: w.highlightEndFrame,
        highlightStartMs: w.highlightStartMs,
        highlightEndMs: w.highlightEndMs,
        leadFrames: w.leadFrames,
      })),
    };
  });

  return { words, pages };
}

/**
 * Audit alignment & frame-lead drift between the first 10s and last 10s of a timeline.
 */
export function measureAlignmentDrift(words, totalDurationMs = 0, fps = 30) {
  if (!Array.isArray(words) || !words.length) {
    return {
      wordCount: 0,
      minLeadFrames: 0,
      maxLeadFrames: 0,
      laggingWordCount: 0,
      excessLeadWordCount: 0,
      first10sMeanLeadMs: 0,
      last10sMeanLeadMs: 0,
      driftMs: 0,
    };
  }
  const frameMs = 1000 / fps;
  const maxEnd = Math.max(totalDurationMs, words.at(-1)?.endMs || 0);
  const first10 = words.filter(w => w.startMs <= 10000);
  const last10 = words.filter(w => w.startMs >= Math.max(0, maxEnd - 10000));

  const meanLeadMs = arr =>
    arr.length
      ? arr.reduce((sum, w) => sum + (w.startMs - w.highlightFrame * frameMs), 0) / arr.length
      : 0;

  let minLeadFrames = Infinity;
  let maxLeadFrames = -Infinity;
  let laggingWordCount = 0;
  let excessLeadWordCount = 0;

  for (const w of words) {
    const leadF = (w.startMs - w.highlightFrame * frameMs) / frameMs;
    if (leadF < minLeadFrames) minLeadFrames = leadF;
    if (leadF > maxLeadFrames) maxLeadFrames = leadF;
    if (leadF < -0.001) laggingWordCount++;
    if (leadF > 2.001) excessLeadWordCount++;
  }

  const firstMean = meanLeadMs(first10);
  const lastMean = meanLeadMs(last10);

  return {
    wordCount: words.length,
    minLeadFrames: Number(minLeadFrames.toFixed(3)),
    maxLeadFrames: Number(maxLeadFrames.toFixed(3)),
    laggingWordCount,
    excessLeadWordCount,
    first10sMeanLeadMs: Number(firstMean.toFixed(2)),
    last10sMeanLeadMs: Number(lastMean.toFixed(2)),
    driftMs: Number(Math.abs(lastMean - firstMean).toFixed(2)),
  };
}
