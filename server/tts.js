import { createHash } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const STUDIO_PYTHON = join(ROOT_DIR, '.venv-studio', 'bin', 'python');
const LOCAL_TTS_SCRIPT = join(ROOT_DIR, 'scripts', 'local_tts.py');

// Distinct neural voice casting per language for Corner A, Corner B, and the Adjudicator.
export const VOICE_CAST = {
  English:      { a: 'en-US-GuyNeural',     b: 'en-GB-RyanNeural',    judge: 'en-US-BrianNeural' },
  Hindi:        { a: 'hi-IN-MadhurNeural',  b: 'hi-IN-SwaraNeural',   judge: 'en-IN-PrabhatNeural' },
  Hinglish:     { a: 'en-IN-PrabhatNeural', b: 'hi-IN-MadhurNeural',  judge: 'en-IN-NeerjaNeural' },
  Urdu:         { a: 'ur-PK-AsadNeural',    b: 'ur-PK-UzmaNeural',    judge: 'ur-IN-SalmanNeural' },
  'Roman Urdu': { a: 'en-IN-PrabhatNeural', b: 'ur-PK-AsadNeural',    judge: 'en-IN-NeerjaNeural' },
  Punjabi:      { a: 'pa-IN-OjasNeural',    b: 'pa-IN-VaaniNeural',   judge: 'en-IN-PrabhatNeural' },
  Spanish:      { a: 'es-ES-AlvaroNeural',  b: 'es-MX-JorgeNeural',   judge: 'es-ES-ElviraNeural' },
  French:       { a: 'fr-FR-HenriNeural',   b: 'fr-CA-AntoineNeural', judge: 'fr-FR-DeniseNeural' },
  German:       { a: 'de-DE-ConradNeural',  b: 'de-AT-JonasNeural',   judge: 'de-DE-KatjaNeural' },
  Portuguese:   { a: 'pt-BR-AntonioNeural', b: 'pt-PT-DuarteNeural',  judge: 'pt-BR-FranciscaNeural' },
  Arabic:       { a: 'ar-SA-HamedNeural',   b: 'ar-EG-ShakirNeural',  judge: 'ar-SA-ZariyahNeural' },
  Russian:      { a: 'ru-RU-DmitryNeural',  b: 'ru-RU-SvetlanaNeural',judge: 'ru-RU-DariyaNeural' },
  Turkish:      { a: 'tr-TR-AhmetNeural',   b: 'tr-TR-EmelNeural',    judge: 'tr-TR-AhmetNeural' },
  Japanese:     { a: 'ja-JP-KeitaNeural',   b: 'ja-JP-DaichiNeural',  judge: 'ja-JP-NanamiNeural' },
  Korean:       { a: 'ko-KR-InJoonNeural',  b: 'ko-KR-BongJinNeural', judge: 'ko-KR-SunHiNeural' },
  Chinese:      { a: 'zh-CN-YunxiNeural',   b: 'zh-CN-YunjianNeural', judge: 'zh-CN-XiaoxiaoNeural' },
};

const MAX_CACHE = 80;
const cache = new Map(); // sha256 -> { audioBuffer: Buffer, words: Array }

export function pickVoice(language = 'English', role = 'a', text = '') {
  const r = role === 'b' || role === 'judge' ? role : 'a';
  // If the text itself is written in Arabic/Urdu script or Devanagari, ensure a native script reader
  if (/[\u0600-\u06FF]/.test(text) && !['Urdu', 'Arabic'].includes(language)) {
    return VOICE_CAST.Urdu[r];
  }
  if (/[\u0900-\u097F]/.test(text) && language !== 'Hindi') {
    return VOICE_CAST.Hindi[r];
  }
  const cast = VOICE_CAST[language] ?? VOICE_CAST.English;
  return cast[r] ?? VOICE_CAST.English[r];
}

// Strip markdown emphasis markers and escape XML characters before embedding inside SSML <speak>.
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '$1')
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .trim();
}

/** Dynamic prosody tuning per battle mode, speaker corner, and segment role for lively broadcast delivery. */
export function getProsody({ mode = 'rap', role = 'a', type = 'verse', fast = false } = {}) {
  if (type === 'intro' || type === 'outro' || type === 'hook') {
    return { rate: fast ? '+12%' : '+7%', pitch: '-2Hz' };
  }
  if (type === 'judge' || role === 'judge') {
    return { rate: fast ? '+10%' : '+5%', pitch: '-2Hz' };
  }
  const cornerPitch = role === 'b' ? '+3Hz' : '-3Hz';
  if (mode === 'rap') {
    return { rate: fast ? '+14%' : '+9%', pitch: cornerPitch };
  }
  if (mode === 'roast') {
    return { rate: fast ? '+9%' : '+2%', pitch: cornerPitch };
  }
  if (mode === 'debate') {
    return { rate: fast ? '+10%' : '+4%', pitch: role === 'b' ? '+2Hz' : '-2Hz' };
  }
  // Poetry & Story preserve natural cadence while keeping subtle corner timbre separation
  return { rate: mode === 'poetry' ? (fast ? '-2%' : '-10%') : (fast ? '+4%' : '-3%'), pitch: role === 'b' ? '+2Hz' : '-2Hz' };
}

/**
 * Synthesize neural MP3 audio AND extract exact millisecond word boundaries
 * from Microsoft Edge Neural TTS for live karaoke captions.
 */
export async function synthesizeSpeechWithTimings({
  text,
  language = 'English',
  role = 'a',
  mode = 'rap',
  type = 'verse',
  fast = false,
}) {
  const safeText = cleanForSpeech(text);
  if (!safeText) throw new Error('empty speech text');
  const voice = pickVoice(language, role, text);
  const prosody = getProsody({ mode, role, type, fast });
  const key = createHash('sha256')
    .update(`${voice}|${prosody.rate}|${prosody.pitch}|${safeText}`)
    .digest('hex');

  if (cache.has(key)) return cache.get(key);

  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, {
      wordBoundaryEnabled: true,
    });
    const { audioStream, metadataStream } = tts.toStream(safeText, prosody);
    const words = [];

    if (metadataStream) {
      metadataStream.on('data', chunk => {
        try {
          const parsed = JSON.parse(chunk.toString());
          for (const item of parsed?.Metadata ?? []) {
            if (item?.Type === 'WordBoundary' && item?.Data?.text?.Text) {
              words.push({
                text: String(item.Data.text.Text),
                offsetMs: Math.max(0, Math.round(Number(item.Data.Offset || 0) / 10000)),
                durationMs: Math.max(40, Math.round(Number(item.Data.Duration || 0) / 10000)),
              });
            }
          }
        } catch {
          /* ignore malformed metadata frame */
        }
      });
    }

    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const audioBuffer = Buffer.concat(chunks);
    if (!audioBuffer.length) throw new Error('empty audio stream');

    const entry = { audioBuffer, words };
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, entry);
    return entry;
  } finally {
    try { tts.close?.(); } catch { /* ignore */ }
  }
}

export async function synthesizeSpeech({ text, language = 'English', role = 'a', mode = 'rap', type = 'verse' }) {
  const { audioBuffer } = await synthesizeSpeechWithTimings({ text, language, role, mode, type });
  return audioBuffer;
}

/** Detect the implemented local Kokoro backend and available hardware. */
export function detectLocalTtsHardware() {
  if (!existsSync(STUDIO_PYTHON) || !existsSync(LOCAL_TTS_SCRIPT)) {
    return { engine: 'msedge-tts', kokoroReady: false, chatterboxReady: false };
  }
  try {
    const out = execFileSync(STUDIO_PYTHON, [LOCAL_TTS_SCRIPT, '--detect'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    return JSON.parse(out.trim().split('\n').at(-1));
  } catch {
    return { engine: 'msedge-tts', kokoroReady: false, chatterboxReady: false };
  }
}

/** Keep source word boundaries anchored after trimming; discard removed words. */
export function trimWordTimings(words, startMs, endMs) {
  return (words || []).flatMap(word => {
    const start = Math.max(startMs, Number(word.offsetMs));
    const end = Math.min(endMs, Number(word.offsetMs) + Number(word.durationMs));
    if (!Number.isFinite(start + end) || end <= start) return [];
    return [{ ...word, offsetMs: Math.round(start - startMs), durationMs: Math.max(1, Math.round(end - start)) }];
  });
}

function probeAudioDurationMs(path) {
  const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], { encoding: 'utf8', timeout: 10000 });
  const ms = Math.round(Number(raw.trim()) * 1000);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('Could not determine synthesized audio duration');
  return ms;
}

function speechTrimWindow(path, ffmpegBin) {
  const durationMs = probeAudioDurationMs(path);
  // Detect only edge silence; pauses inside poetry/comedy remain untouched.
  const result = spawnSync(ffmpegBin, ['-hide_banner', '-nostats', '-i', path, '-af', 'silencedetect=noise=-48dB:d=0.025', '-f', 'null', '-'], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error('Silence detection failed');
  const log = result.stderr || '';
  let startMs = 0;
  let endMs = durationMs;
  const intervals = [...log.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];
  for (const match of intervals) {
    const end = Number(match[1]) * 1000;
    const start = end - Number(match[2]) * 1000;
    if (start <= 2) startMs = Math.max(0, end - 20);
    if (end >= durationMs - 35) endMs = Math.min(durationMs, start + 45);
  }
  if (endMs <= startMs) throw new Error('Synthesized speech contains no audible content');
  return { startMs, endMs };
}

/**
 * Batch-synthesize line-by-line vocal stems (`[{ id, text, language, role, speaker, mode, segmentType, bpm, fast, audioPath }]`).
 * Uses local `Kokoro-82M` first (with silence trimming & bounded rap duration fitting),
 * and seamlessly falls back to `msedge-tts` + FFmpeg silence trim for multilingual languages (Urdu/Hinglish/etc.).
 */
export async function synthesizeLineStemsBatch(lineItems, { ffmpegBin = 'ffmpeg', probeDurationFn = null } = {}) {
  const results = new Map();
  if (!Array.isArray(lineItems) || !lineItems.length) return results;

  // 1. Try Local Studio TTS (Kokoro-82M) in a single warm batch
  if (existsSync(STUDIO_PYTHON) && existsSync(LOCAL_TTS_SCRIPT)) {
    const batchFile = join(tmpdir(), `botbrawl-tts-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
    try {
      writeFileSync(batchFile, JSON.stringify(lineItems, null, 2), 'utf8');
      const stdout = execFileSync(STUDIO_PYTHON, [LOCAL_TTS_SCRIPT, '--batch', batchFile], {
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout.trim().split('\n').at(-1));
      if (parsed?.ok && parsed.results) {
        for (const [id, r] of Object.entries(parsed.results)) {
          if (r?.ok && r.durationMs > 0) {
            results.set(id, {
              ok: true,
              engine: r.engine || 'kokoro',
              voice: r.voice,
              durationMs: r.durationMs,
              barMeta: r.barMeta || null,
              words: [],
            });
          }
        }
      }
    } catch (err) {
      console.error('[local-tts-warning] Falling back to msedge-tts:', err.message);
    } finally {
      try { unlinkSync(batchFile); } catch { /* ignore */ }
    }
  }

  // 2. Fallback to line-by-line `msedge-tts` + FFmpeg silence trim for any remaining multilingual items
  const remaining = lineItems.filter(it => !results.has(String(it.id)));
  if (remaining.length > 0) {
    // Bound simultaneous websocket requests instead of opening one per verse.
    for (let batchStart = 0; batchStart < remaining.length; batchStart += 4) {
    await Promise.all(
      remaining.slice(batchStart, batchStart + 4).map(async item => {
        const id = String(item.id);
        const rawMp3 = `${item.audioPath}.raw.mp3`;
        try {
          const res = await synthesizeSpeechWithTimings({
            text: item.text,
            language: item.language || 'English',
            role: item.role || 'a',
            mode: item.mode || 'rap',
            type: item.segmentType === 'hook' || item.segmentType === 'outro' ? 'outro' : (item.segmentType || 'verse'),
            fast: Boolean(item.fast),
          });
          writeFileSync(rawMp3, res.audioBuffer);

          let words = res.words || [];
          // Keep metadata on the same timeline as the trimmed decoded waveform.
          if (ffmpegBin) {
              const window = speechTrimWindow(rawMp3, ffmpegBin);
              execFileSync(
                ffmpegBin,
                [
                  '-y', '-hide_banner', '-loglevel', 'error',
                  '-i', rawMp3,
                  '-af', `atrim=start=${window.startMs / 1000}:end=${window.endMs / 1000},asetpts=PTS-STARTPTS`,
                  '-ar', '48000',
                  '-ac', '1',
                  '-c:a', item.audioPath.toLowerCase().endsWith('.mp3') ? 'libmp3lame' : 'pcm_s24le',
                  ...(item.audioPath.toLowerCase().endsWith('.mp3') ? ['-b:a', '192k'] : []),
                  item.audioPath,
                ],
                { timeout: 15000 },
              );
              words = trimWordTimings(words, window.startMs, window.endMs);
          } else {
            if (!item.audioPath.toLowerCase().endsWith('.mp3')) throw new Error('FFmpeg is required to write a PCM vocal stem');
            writeFileSync(item.audioPath, res.audioBuffer);
          }

          const durationMs = probeDurationFn
            ? probeDurationFn(item.audioPath, res.audioBuffer.length)
            : probeAudioDurationMs(item.audioPath);
          results.set(id, {
            ok: true,
            engine: 'msedge-tts',
            voice: pickVoice(item.language || 'English', item.role || 'a', item.text),
            durationMs,
            barMeta: null,
            words,
          });
        } catch (err) {
          console.error(`[tts-fallback-warning] ${id}:`, err.message);
          results.set(id, {
            ok: false,
            engine: 'fallback-timer',
            durationMs: Math.max(1100, Math.min(8000, String(item.text || '').length * 56)),
            words: [],
          });
        } finally {
          try { unlinkSync(rawMp3); } catch { /* ignore */ }
        }
      }),
    );
    }
  }

  return results;
}
