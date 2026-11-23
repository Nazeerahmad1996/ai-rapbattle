/**
 * Node bridge to the Apple Silicon `stable-ts` + `faster-whisper-large-v3`
 * forced word aligner & final-mix intelligibility verifier (`scripts/align_words.py`).
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
export const STUDIO_PYTHON = join(ROOT_DIR, '.venv-studio', 'bin', 'python');
export const ALIGN_SCRIPT = join(ROOT_DIR, 'scripts', 'align_words.py');

export function isForcedAlignerAvailable() {
  return existsSync(STUDIO_PYTHON) && existsSync(ALIGN_SCRIPT);
}

/**
 * Batch force-align multiple `{ id, audioPath, text, language }` line stems in one Python invocation.
 * Returns `Map<id, Array<{ text, offsetMs, durationMs }>>`.
 */
export function forceAlignBatch(items, { model = 'large-v3', timeoutMs = 180000 } = {}) {
  const outMap = new Map();
  if (!Array.isArray(items) || !items.length || !isForcedAlignerAvailable()) {
    return outMap;
  }

  const validItems = items.filter(it => it && it.audioPath && existsSync(it.audioPath) && String(it.text ?? '').trim());
  if (!validItems.length) return outMap;

  const batchJsonPath = join(tmpdir(), `botbrawl-align-batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  try {
    writeFileSync(batchJsonPath, JSON.stringify(validItems, null, 2), 'utf8');
    const stdout = execFileSync(
      STUDIO_PYTHON,
      [ALIGN_SCRIPT, '--batch', batchJsonPath, '--model', model],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const parsed = JSON.parse(stdout.trim().split('\n').at(-1));
    if (parsed?.ok && parsed.results) {
      for (const [id, entry] of Object.entries(parsed.results)) {
        if (entry?.ok && Array.isArray(entry.words) && entry.words.length > 0) {
          outMap.set(id, entry.words);
        }
      }
    }
  } catch (err) {
    console.error('[forced-aligner-warning] Batch alignment fallback:', err.message);
  } finally {
    try { unlinkSync(batchJsonPath); } catch { /* ignore */ }
  }
  return outMap;
}

/**
 * Transcribe the final mixed MP4 (vocals + beat + SFX) using local `faster-whisper-large-v3`
 * and verify intelligibility against the exact script (`>= 95%` target).
 */
export function verifyMixIntelligibility({ mediaPath, scriptText, language = 'English', model = 'large-v3' }) {
  if (!isForcedAlignerAvailable() || !mediaPath || !existsSync(mediaPath)) {
    return { ok: false, wordMatchPct: 0, reason: 'aligner or media file unavailable' };
  }
  const scriptFile = join(tmpdir(), `botbrawl-script-${Date.now()}.txt`);
  try {
    writeFileSync(scriptFile, String(scriptText ?? ''), 'utf8');
    const stdout = execFileSync(
      STUDIO_PYTHON,
      [ALIGN_SCRIPT, '--verify-mix', mediaPath, '--text', scriptFile, '--language', language, '--model', model],
      {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } catch (err) {
    return { ok: false, wordMatchPct: 0, error: err.message };
  } finally {
    try { unlinkSync(scriptFile); } catch { /* ignore */ }
  }
}

