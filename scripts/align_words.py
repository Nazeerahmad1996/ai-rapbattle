#!/usr/bin/env python3
"""
Phase 2 & QA Forced Word Aligner + Final-Mix Intelligibility Verifier.

Uses `stable-ts` (`stable_whisper.load_faster_whisper`) with the locally cached
`Systran/faster-whisper-large-v3` model on Apple Silicon (`int8`) to:
  1. Force-align the EXACT ground-truth script tokens onto final trimmed voice audio
     (`model.align(audio_path, text, language=...)`) — never relying on free-form Whisper
     guesses or unaligned TTS estimates.
  2. Refine word onsets against short-time waveform energy so highlight lead calibration
     never lags consonant attacks.
  3. Transcribe the final mixed MP4 (`--verify-mix`) and compute exact script word-match %
     for the mandatory >= 95% intelligibility gate.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf

LANG_MAP = {
    "english": "en",
    "hindi": "hi",
    "hinglish": "hi",
    "urdu": "ur",
    "roman urdu": "ur",
    "punjabi": "pa",
    "spanish": "es",
    "french": "fr",
    "german": "de",
    "portuguese": "pt",
    "arabic": "ar",
    "russian": "ru",
    "turkish": "tr",
    "japanese": "ja",
    "korean": "ko",
    "chinese": "zh",
}


def resolve_lang_code(lang_name: str) -> str:
    if not lang_name:
        return "en"
    key = lang_name.strip().lower()
    if len(key) == 2:
        return key
    return LANG_MAP.get(key, "en")


def decode_to_16k_mono_wav(input_path: str) -> str:
    """Decode any MP3/WAV/MP4 file to a temporary 16kHz mono PCM WAV via ffmpeg."""
    fd, tmp_wav = tempfile.mkstemp(suffix=".wav", prefix="align16k_")
    os.close(fd)
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        input_path,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        tmp_wav,
    ]
    subprocess.run(cmd, check=True)
    return tmp_wav


def refine_word_onsets_with_energy(wav_path: str, words: list[dict]) -> list[dict]:
    """
    Micro-refine DTW word start times using 5ms RMS energy envelope so plosive/fricative
    attacks never start slightly before the timestamp (prevents highlight lag).
    """
    try:
        samples, sr = sf.read(wav_path, dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
    except Exception:
        return words

    if len(samples) == 0:
        return words

    win = max(1, int(sr * 0.005))  # 5ms hop
    n_frames = len(samples) // win
    if n_frames < 4:
        return words

    trimmed = samples[: n_frames * win].reshape(n_frames, win)
    rms = np.sqrt(np.mean(trimmed * trimmed, axis=1) + 1e-12)
    noise_floor = float(np.percentile(rms, 15))
    speech_thresh = max(noise_floor * 2.4, float(np.max(rms)) * 0.045)

    refined = []
    prev_end_ms = 0.0
    for idx, w in enumerate(words):
        start_ms = float(w["offsetMs"])
        dur_ms = float(w["durationMs"])
        end_ms = start_ms + dur_ms

        # Look up to 35ms earlier than DTW start for an unmistakable consonant energy rise,
        # bounded by the previous word's end.
        search_lo_ms = max(prev_end_ms, start_ms - 35.0)
        lo_idx = max(0, int((search_lo_ms / 1000.0) * sr / win))
        hi_idx = min(n_frames - 1, int(((start_ms + 25.0) / 1000.0) * sr / win))

        best_ms = start_ms
        if hi_idx > lo_idx:
            window_rms = rms[lo_idx : hi_idx + 1]
            above = np.where(window_rms >= speech_thresh)[0]
            if len(above) > 0:
                onset_frame = lo_idx + int(above[0])
                candidate_ms = (onset_frame * win / sr) * 1000.0
                if candidate_ms < start_ms:
                    best_ms = max(prev_end_ms, candidate_ms)

        new_start = round(max(0.0, best_ms), 1)
        new_end = round(max(new_start + 40.0, end_ms), 1)
        refined.append(
            {
                "text": w["text"],
                "offsetMs": int(round(new_start)),
                "durationMs": int(round(new_end - new_start)),
            }
        )
        prev_end_ms = new_end
    return refined


def map_aligned_tokens_to_script_words(script_text: str, raw_aligned_words: list[dict]) -> list[dict]:
    """
    Ensure 1-to-1 correspondence between whitespace-delimited script tokens (preserving exact
    display punctuation/casing like `GPT-OSS`, `off-camera`, `tag’s`) and aligned DTW sub-words.
    """
    display_tokens = [t for t in re.split(r"\s+", script_text.strip()) if t]
    if not display_tokens:
        return []
    if not raw_aligned_words:
        return []

    def clean_alpha(s: str) -> str:
        return re.sub(r"[^\w\u0600-\u06FF\u0900-\u097F]+", "", s.lower(), flags=re.UNICODE)

    # Greedily consume raw aligned sub-words whose characters match each display token
    mapped = []
    r_idx = 0
    n_raw = len(raw_aligned_words)

    for d_idx, d_tok in enumerate(display_tokens):
        target_norm = clean_alpha(d_tok)
        if r_idx >= n_raw:
            last_end = mapped[-1]["offsetMs"] + mapped[-1]["durationMs"] if mapped else 0
            mapped.append({"text": d_tok, "offsetMs": last_end + 10, "durationMs": 120})
            continue

        start_r = r_idx
        acc_norm = clean_alpha(raw_aligned_words[r_idx]["word"])
        r_idx += 1

        # Merge split hyphen/apostrophe sub-words (e.g. `GPT` + `OSS` -> `GPT-OSS`, `tag` + `'s` -> `tag's`)
        while (
            r_idx < n_raw
            and target_norm
            and len(acc_norm) < len(target_norm)
            and target_norm.startswith(acc_norm)
            and (n_raw - r_idx) >= (len(display_tokens) - 1 - d_idx)
        ):
            next_piece = clean_alpha(raw_aligned_words[r_idx]["word"])
            if not next_piece or len(acc_norm) + len(next_piece) <= len(target_norm) + 2:
                acc_norm += next_piece
                r_idx += 1
            else:
                break

        first_w = raw_aligned_words[start_r]
        last_w = raw_aligned_words[r_idx - 1]
        start_ms = max(0.0, float(first_w["start"]) * 1000.0)
        end_ms = max(start_ms + 40.0, float(last_w["end"]) * 1000.0)
        mapped.append(
            {
                "text": d_tok,
                "offsetMs": int(round(start_ms)),
                "durationMs": int(round(end_ms - start_ms)),
            }
        )

    return mapped


def load_aligner_model(model_name: str = "large-v3"):
    import stable_whisper

    return stable_whisper.load_faster_whisper(
        model_name,
        device="cpu",
        compute_type="int8",
    )


def align_single_item(model, audio_path: str, script_text: str, language: str) -> dict:
    clean_text = script_text.strip()
    if not clean_text or not os.path.exists(audio_path):
        return {"ok": False, "words": [], "error": "missing audio or empty text"}

    lang_code = resolve_lang_code(language)
    tmp_wav = decode_to_16k_mono_wav(audio_path)
    try:
        result = model.align(
            tmp_wav,
            clean_text,
            language=lang_code,
            fast_mode=True,
            verbose=False,
        )
        raw_words = []
        for seg in result.segments:
            for w in seg.words:
                raw_words.append(
                    {
                        "word": w.word,
                        "start": float(w.start),
                        "end": float(w.end),
                    }
                )
        mapped = map_aligned_tokens_to_script_words(clean_text, raw_words)
        refined = refine_word_onsets_with_energy(tmp_wav, mapped)
        return {"ok": True, "words": refined, "rawCount": len(raw_words)}
    finally:
        try:
            os.remove(tmp_wav)
        except OSError:
            pass


def normalize_for_wer(text: str) -> list[str]:
    num_map = {
        "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
        "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
        "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13",
        "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
        "eighteen": "18", "nineteen": "19", "twenty": "20", "thirty": "30",
        "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70",
        "eighty": "80", "ninety": "90", "hundred": "100", "thousand": "1000",
        "percent": "%", "pct": "%",
    }
    # Clean apostrophes, possessives, and punctuation
    cleaned = re.sub(r"['’]s\b", "", text.lower())
    cleaned = re.sub(r"['’]", "", cleaned)
    # Normalize common speech compound spellings
    cleaned = re.sub(r"\bshout[\s-]*out\b", "shoutout", cleaned)
    cleaned = re.sub(r"[^\w\s\u0600-\u06FF\u0900-\u097F]", " ", cleaned, flags=re.UNICODE)
    raw_tokens = [t.strip("_") for t in cleaned.split() if t.strip("_")]

    tokens = []
    i = 0
    while i < len(raw_tokens):
        # Compound numbers like "eighty" "five" -> "85"
        if (
            i + 1 < len(raw_tokens)
            and raw_tokens[i] in ("twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
            and raw_tokens[i + 1] in ("one", "two", "three", "four", "five", "six", "seven", "eight", "nine")
        ):
            tens = int(num_map[raw_tokens[i]])
            ones = int(num_map[raw_tokens[i + 1]])
            tokens.append(str(tens + ones))
            i += 2
            continue
        tok = raw_tokens[i]
        tokens.append(num_map.get(tok, tok))
        i += 1

    return tokens


def score_transcript(script_text: str, transcript: str) -> dict:
    """Word accuracy derived from edit distance, including inserted speech.

    Normalization handles punctuation/number spelling consistently for both
    sides. Proper names receive the same exact-token treatment as other words.
    This is a transcription agreement measurement, not a human listening test.
    """
    ref_tokens = normalize_for_wer(script_text)
    hyp_tokens = normalize_for_wer(transcript)
    if not ref_tokens:
        return {'ok': False, 'wordMatchPct': None, 'error': 'No reference words', 'transcript': transcript}
    # Each cell stores edit cost, substitutions, deletions, and insertions.
    previous = [(j, 0, 0, j) for j in range(len(hyp_tokens) + 1)]
    for i, ref_word in enumerate(ref_tokens, 1):
        current = [(i, 0, i, 0)]
        for j, hyp_word in enumerate(hyp_tokens, 1):
            if ref_word == hyp_word:
                current.append(previous[j - 1])
                continue
            cost, substitutions, deletions, insertions = previous[j - 1]
            substitute = (cost + 1, substitutions + 1, deletions, insertions)
            cost, substitutions, deletions, insertions = previous[j]
            delete = (cost + 1, substitutions, deletions + 1, insertions)
            cost, substitutions, deletions, insertions = current[j - 1]
            insert = (cost + 1, substitutions, deletions, insertions + 1)
            current.append(min((substitute, delete, insert), key=lambda entry: entry[0]))
        previous = current
    edits, substitutions, deletions, insertions = previous[-1]
    wer = edits / len(ref_tokens)
    return {
        'ok': True,
        'wordMatchPct': round(max(0, 1 - wer) * 100, 2),
        'wordErrorRatePct': round(wer * 100, 2),
        'wordErrors': {'substitutions': substitutions, 'deletions': deletions, 'insertions': insertions},
        'refWordCount': len(ref_tokens),
        'hypWordCount': len(hyp_tokens),
        'scoreMethod': '1 - word edit distance / reference word count; insertions included',
        'transcript': transcript,
    }


def verify_mix_intelligibility(model_name: str, media_path: str, script_text: str, language: str) -> dict:
    from faster_whisper import WhisperModel

    wm = WhisperModel(model_name, device="cpu", compute_type="int8")
    lang_code = resolve_lang_code(language)
    tmp_wav = decode_to_16k_mono_wav(media_path)
    try:
        samples, _ = sf.read(tmp_wav, dtype="float32")
        segments, _ = wm.transcribe(
            samples,
            language=lang_code,
            beam_size=3,
            vad_filter=True,
        )
        transcript = " ".join(seg.text.strip() for seg in segments).strip()
    finally:
        try:
            os.remove(tmp_wav)
        except OSError:
            pass

    return score_transcript(script_text, transcript)


def main():
    parser = argparse.ArgumentParser(description="Forced Aligner & Whisper Intelligibility QA")
    parser.add_argument("--batch", help="Path to JSON file listing [{id, audioPath, text, language}]")
    parser.add_argument("--audio", help="Single audio file path to force-align")
    parser.add_argument("--text", help="Exact ground-truth script for --audio or --verify-mix")
    parser.add_argument("--language", default="English")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--verify-mix", help="Path to final mixed MP4/WAV for Whisper intelligibility check")
    args = parser.parse_args()

    if args.verify_mix:
        script_text = args.text or ""
        if os.path.exists(script_text):
            script_text = Path(script_text).read_text(encoding="utf-8")
        out = verify_mix_intelligibility(args.model, args.verify_mix, script_text, args.language)
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        return

    model = load_aligner_model(args.model)

    if args.batch:
        items = json.loads(Path(args.batch).read_text(encoding="utf-8"))
        results = {}
        for item in items:
            item_id = str(item["id"])
            try:
                results[item_id] = align_single_item(
                    model,
                    item["audioPath"],
                    item["text"],
                    item.get("language", args.language),
                )
            except Exception as exc:
                results[item_id] = {"ok": False, "words": [], "error": str(exc)}
        sys.stdout.write(json.dumps({"ok": True, "results": results}, ensure_ascii=False) + "\n")
        return

    if args.audio and args.text:
        res = align_single_item(model, args.audio, args.text, args.language)
        sys.stdout.write(json.dumps(res, ensure_ascii=False) + "\n")
        return

    parser.error("Provide --batch <json>, --audio <file> --text <str>, or --verify-mix <mp4> --text <str>")


if __name__ == "__main__":
    main()
