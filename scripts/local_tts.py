#!/usr/bin/env python3
"""
Phase 4 Local Studio Voice Synthesizer (`scripts/local_tts.py`).

Local spoken-voice TTS engine: Kokoro-82M v1.0 ONNX (Apache-2.0).
Duration fitting puts spoken lines into musical cells; it does not generate sung/rap prosody.

Features:
  - Distinct voice timbre & pace per AI model family & corner (Corner A, Corner B, Judge)
  - Generates per line, trims dead leading/trailing silence cleanly
  - Rap duration fitter: whole/half-bar cells at the supplied tempo, with a breath gap;
    bounded re-synthesis and pitch-preserving FFmpeg `atempo` within +-12%.
    Reports an unsuccessful fit when the safe adjustment cannot reach a cell.
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

ROOT_DIR = Path(__file__).resolve().parent.parent
KOKORO_MODEL = ROOT_DIR / "data" / "models" / "kokoro" / "kokoro-v1.0.int8.onnx"
KOKORO_VOICES = ROOT_DIR / "data" / "models" / "kokoro" / "voices-v1.0.bin"

KOKORO_LANG_MAP = {
    "english": "en-us",
    "english-gb": "en-gb",
    "hindi": "hi",
    "spanish": "es",
    "french": "fr-fr",
    "portuguese": "pt-br",
    "japanese": "ja",
    "chinese": "cmn",
}

# Distinct voice timbre & base pace per AI family so every model sounds immediately recognizable
MODEL_VOICE_PROFILES = [
    ("claude",   {"voice": "bm_george",  "lang": "en-gb", "speed": 1.08}),
    ("opus",     {"voice": "bm_george",  "lang": "en-gb", "speed": 1.08}),
    ("sonnet",   {"voice": "am_puck",    "lang": "en-us", "speed": 1.10}),
    ("gpt",      {"voice": "am_fenrir",  "lang": "en-us", "speed": 1.07}),
    ("codex",    {"voice": "am_puck",    "lang": "en-us", "speed": 1.08}),
    ("gemini",   {"voice": "af_heart",    "lang": "en-us", "speed": 1.09}),
    ("argon",    {"voice": "am_michael", "lang": "en-us", "speed": 1.07}),
    ("kimi",     {"voice": "af_bella",    "lang": "en-us", "speed": 1.09}),
]

FALLBACK_CORNER_VOICES = {
    "a":     {"voice": "am_fenrir", "lang": "en-us", "speed": 1.07},
    "b":     {"voice": "bm_george", "lang": "en-gb", "speed": 1.09},
    "judge": {"voice": "bf_emma",  "lang": "en-gb", "speed": 1.12},
}

ALT_CORNER_B_VOICES = ["am_puck", "bm_george", "af_heart", "af_bella", "am_michael"]


def detect_hardware_engine() -> dict:
    has_cuda = False
    has_mps = False
    try:
        import torch
        has_cuda = bool(torch.cuda.is_available())
        has_mps = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    except Exception:
        pass

    # This entry point implements Kokoro only. Installed MLX packages/reference
    # audio are not evidence that a Chatterbox synthesis adapter is implemented.
    has_kokoro = KOKORO_MODEL.exists() and KOKORO_VOICES.exists()
    return {
        "engine": "kokoro" if has_kokoro else "none",
        "cuda": has_cuda,
        "mps": has_mps,
        "kokoroReady": has_kokoro,
        "chatterboxReady": False,
    }


def prepare_text_for_speech(raw: str) -> str:
    """Clean markdown & normalize punctuation into natural spoken phrasing cues."""
    s = str(raw or "").strip()
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"\*([^*]+?)\*", r"\1", s)
    s = re.sub(r"`([^`]+?)`", r"\1", s)
    # Pronounce technical tokens cleanly
    s = re.sub(r"\bGPT-OSS\b", "G P T O S S", s, flags=re.IGNORECASE)
    s = re.sub(r"\b120B\b", "120 B", s, flags=re.IGNORECASE)
    s = re.sub(r"\b5\.5\b", "five point five", s)
    s = re.sub(r"\b3\.8\b", "three point eight", s)
    # Turn em-dashes into clean spoken comma-pause
    s = s.replace("—", ", ").replace("–", ", ")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def pick_kokoro_profile(language: str, role: str, speaker: str = "", mode: str = "rap", avoid_voice: str = "") -> dict | None:
    lang_key = (language or "English").strip().lower()
    if lang_key not in KOKORO_LANG_MAP:
        return None

    # Non-English Kokoro voices
    if lang_key not in {"english", "english-gb"}:
        k_lang = KOKORO_LANG_MAP[lang_key]
        cast_by_lang = {
            "hi":    {"a": "hm_omega", "b": "hf_alpha", "judge": "hm_psi"},
            "es":    {"a": "em_alex",  "b": "ef_dora",  "judge": "em_santa"},
            "fr-fr": {"a": "ff_siwis", "b": "ff_siwis", "judge": "ff_siwis"},
            "pt-br": {"a": "pm_alex",  "b": "pf_dora",  "judge": "pm_santa"},
            "ja":    {"a": "jm_kumo",  "b": "jf_alpha", "judge": "jf_nezumi"},
            "cmn":   {"a": "zm_yunjian", "b": "zm_yunxi", "judge": "zf_xiaoxiao"},
        }
        v = cast_by_lang.get(k_lang, {}).get(role, "am_fenrir")
        return delivery_profile({"voice": v, "lang": k_lang, "speed": 1.0}, mode, role)

    if role == "judge":
        return delivery_profile(dict(FALLBACK_CORNER_VOICES["judge"]), mode, role)

    spk_lower = (speaker or "").lower()
    chosen = None
    for substr, prof in MODEL_VOICE_PROFILES:
        if substr in spk_lower:
            chosen = dict(prof)
            break
    if not chosen:
        chosen = dict(FALLBACK_CORNER_VOICES.get(role, FALLBACK_CORNER_VOICES["a"]))

    if avoid_voice and chosen["voice"] == avoid_voice:
        for alt in ALT_CORNER_B_VOICES:
            if alt != avoid_voice:
                chosen["voice"] = alt
                chosen["lang"] = "en-gb" if alt.startswith("b") else "en-us"
                break

    return delivery_profile(chosen, mode, role)


def delivery_profile(profile: dict, mode: str, role: str) -> dict:
    """Keep comedy conversational and poetry spacious; never flatten all modes to rap."""
    pace, sentence_pause, clause_pause = {
        "rap": (1.0, 0.10, 0.045),
        "roast": (0.97, 0.27, 0.13),
        "debate": (0.98, 0.22, 0.10),
        "poetry": (0.86, 0.42, 0.20),
        "story": (0.92, 0.32, 0.15),
    }.get(mode, (0.95, 0.25, 0.12))
    if role == "judge":
        pace, sentence_pause, clause_pause = 0.93, 0.25, 0.12
    return {**profile, "speed": round(profile["speed"] * pace, 3),
            "sentence_pause": sentence_pause, "clause_pause": clause_pause}


def create_voice(kokoro, text: str, profile: dict, speed: float | None = None):
    return kokoro.create(text, voice=profile["voice"],
                         speed=profile["speed"] if speed is None else speed,
                         lang=profile["lang"],
                         sentence_pause=profile.get("sentence_pause", 0.25),
                         clause_pause=profile.get("clause_pause", 0.1))


def trim_waveform_silence(samples: np.ndarray, sr: int) -> np.ndarray:
    """Trim dead leading/trailing silence while keeping natural 18ms attack & 40ms release."""
    if len(samples) == 0:
        return samples
    win = max(1, int(sr * 0.005))
    n_f = len(samples) // win
    if n_f < 4:
        return samples
    rms = np.sqrt(np.mean(samples[: n_f * win].reshape(n_f, win) ** 2, axis=1) + 1e-12)
    thresh = max(float(np.max(rms)) * 0.022, 0.0025)
    active = np.where(rms >= thresh)[0]
    if len(active) == 0:
        return samples
    pad_pre = int(sr * 0.018)
    pad_post = int(sr * 0.042)
    start = max(0, int(active[0]) * win - pad_pre)
    end = min(len(samples), int(active[-1] + 1) * win + pad_post)
    trimmed = samples[start:end].copy()
    # 8ms micro-fade at edges to prevent zero-crossing clicks
    fade_n = min(len(trimmed) // 4, int(sr * 0.008))
    if fade_n > 2:
        ramp = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
        trimmed[:fade_n] *= ramp
        trimmed[-fade_n:] *= ramp[::-1]
    return trimmed


def pitch_preserving_atempo(samples: np.ndarray, sr: int, tempo_ratio: float) -> np.ndarray:
    """Apply FFmpeg pitch-preserving WSOLA `atempo` strictly clamped within [0.88, 1.12] (+-12%)."""
    ratio = float(np.clip(tempo_ratio, 0.88, 1.12))
    if abs(ratio - 1.0) < 0.015:
        return samples
    fd_in, tmp_in = tempfile.mkstemp(suffix=".wav", prefix="atempo_in_")
    fd_out, tmp_out = tempfile.mkstemp(suffix=".wav", prefix="atempo_out_")
    os.close(fd_in)
    os.close(fd_out)
    try:
        sf.write(tmp_in, samples, sr, subtype="FLOAT")
        subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", tmp_in,
                "-af", f"atempo={ratio:.4f}",
                "-ar", str(sr),
                tmp_out,
            ],
            check=True,
        )
        stretched, _ = sf.read(tmp_out, dtype="float32")
        return stretched
    finally:
        for p in (tmp_in, tmp_out):
            try:
                os.remove(p)
            except OSError:
                pass


def fit_rap_line_to_bars(
    kokoro,
    speech_text: str,
    profile: dict,
    samples: np.ndarray,
    sr: int,
    bpm: float = 90.0,
) -> tuple[np.ndarray, dict]:
    """
    Lock rap verse lines to fixed musical bar pockets at `bpm` (default 90 BPM -> 1 bar = 2.667s).
    Each line + >=320ms breath gap fills 1, 1.5, or 2 bars cleanly.
    Time-stretches ONLY within +-12%; otherwise regenerates at adjusted TTS speed!
    """
    if not np.isfinite(bpm) or not 40 <= bpm <= 240:
        raise ValueError("bpm must be between 40 and 240")
    bar_sec = 240.0 / bpm
    raw_dur = len(samples) / sr
    breath_sec = min(0.44, max(0.24, 30.0 / bpm))
    # Extend the grid for long lines instead of forcing everything into <=2.5 bars.
    max_half_bars = max(4, int(np.ceil((raw_dur + breath_sec) / bar_sec * 2)) + 2)
    candidates = [(n / 2, n / 2 * bar_sec - breath_sec) for n in range(2, max_half_bars + 1)]
    bars_chosen, target_sec = min(candidates, key=lambda c: abs(np.log(raw_dur / max(0.1, c[1]))))
    needed_tempo = raw_dur / max(0.1, target_sec)
    regenerated = False
    if not 0.88 <= needed_tempo <= 1.12:
        # Bound re-synthesis too: an arbitrarily fast TTS speed also harms diction.
        new_speed = float(np.clip(profile["speed"] * needed_tempo,
                                  max(0.85, profile["speed"] * 0.88),
                                  min(1.24, profile["speed"] * 1.12)))
        wav2, sr2 = create_voice(kokoro, speech_text, profile, new_speed)
        if sr2 != sr:
            raise ValueError("TTS changed sample rate during bar fitting")
        candidate = trim_waveform_silence(np.asarray(wav2, dtype=np.float32), sr)
        ratio2 = len(candidate) / sr / target_sec
        if abs(np.log(max(1e-6, ratio2))) < abs(np.log(max(1e-6, needed_tempo))):
            samples, needed_tempo = candidate, ratio2
            regenerated = True

    applied_tempo = 1.0
    if 0.88 <= needed_tempo <= 1.12 and abs(needed_tempo - 1.0) >= 0.015:
        samples = pitch_preserving_atempo(samples, sr, needed_tempo)
        applied_tempo = round(float(needed_tempo), 4)
    final_sec = len(samples) / sr
    return samples, {
        "bars": bars_chosen,
        "cellMs": round(bars_chosen * bar_sec * 1000),
        "breathMs": round(breath_sec * 1000),
        "targetSec": round(target_sec, 3),
        "finalSec": round(final_sec, 3),
        "atempo": applied_tempo,
        "regenerated": regenerated,
        "fitted": abs(final_sec - target_sec) <= 0.06,
        "delivery": "beat-fitted-speech",
    }


def export_audio_file(samples: np.ndarray, sr: int, out_path: str):
    """Write crisp 48kHz mono PCM WAV (or MP3 if .mp3 requested) via ffmpeg."""
    out_p = Path(out_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    # Peak-normalize clean dry stem to -3.0 dBFS before mixer chain
    pk = float(np.max(np.abs(samples))) if len(samples) else 0.0
    if not np.isfinite(samples).all() or pk <= 1e-6:
        raise ValueError("TTS produced no finite audible samples")
    if pk > 1e-6:
        samples = samples * ((10.0 ** (-3.0 / 20.0)) / pk)

    if out_p.suffix.lower() == ".wav" and sr == 48000:
        sf.write(str(out_p), samples, 48000, subtype="PCM_16")
        return

    fd, tmp_wav = tempfile.mkstemp(suffix=".wav", prefix="tts_raw_")
    os.close(fd)
    try:
        sf.write(tmp_wav, samples, sr, subtype="FLOAT")
        if out_p.suffix.lower() == ".mp3":
            cmd = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", tmp_wav, "-ar", "48000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "192k",
                str(out_p),
            ]
        else:
            cmd = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", tmp_wav, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le",
                str(out_p),
            ]
        subprocess.run(cmd, check=True)
    finally:
        try:
            os.remove(tmp_wav)
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(description="Local Studio spoken-voice TTS (Kokoro-82M)")
    parser.add_argument("--detect", action="store_true", help="Print detected TTS engine & hardware JSON")
    parser.add_argument("--batch", help="Path to JSON array of line items to synthesize")
    args = parser.parse_args()

    hw = detect_hardware_engine()
    if args.detect:
        sys.stdout.write(json.dumps(hw) + "\n")
        return

    if not args.batch:
        parser.error("Provide --detect or --batch <json>")

    items = json.loads(Path(args.batch).read_text(encoding="utf-8"))
    if not hw["kokoroReady"]:
        sys.stdout.write(json.dumps({"ok": False, "reason": "kokoro weights missing", "hw": hw}) + "\n")
        return

    from kokoro_onnx import Kokoro
    kokoro = Kokoro(str(KOKORO_MODEL), str(KOKORO_VOICES))

    results = {}
    voice_a_used = ""
    for item in items:
        item_id = str(item["id"])
        language = item.get("language", "English")
        role = item.get("role", "a")
        speaker = item.get("speaker", "")
        mode = item.get("mode", "rap")
        text = item.get("text", "")
        # A local English reader must not pronounce Arabic/Devanagari as English.
        if re.search(r"[\u0600-\u06ff]", text) and language.lower() not in {"urdu", "arabic"}:
            language = "Urdu"
        elif re.search(r"[\u0900-\u097f]", text):
            language = "Hindi"
        seg_type = item.get("segmentType", "verse")
        bpm = float(item.get("bpm", 90.0))

        profile = pick_kokoro_profile(
            language=language,
            role=role,
            speaker=speaker,
            mode=mode,
            avoid_voice=(voice_a_used if role == "b" else ""),
        )
        if profile is None:
            results[item_id] = {"ok": False, "fallback": "msedge-tts", "reason": f"language {language} uses multilingual fallback"}
            continue

        if role == "a" and not voice_a_used:
            voice_a_used = profile["voice"]

        if item.get("fast"):
            profile = {**profile, "speed": round(min(1.26, profile["speed"] * 1.10), 2)}

        speech_text = prepare_text_for_speech(item.get("text", ""))
        if not speech_text:
            results[item_id] = {"ok": False, "error": "empty text"}
            continue

        try:
            raw_wav, sr = create_voice(kokoro, speech_text, profile)
            trimmed = trim_waveform_silence(np.asarray(raw_wav, dtype=np.float32), sr)
            bar_meta = None
            if mode == "rap" and seg_type == "verse":
                trimmed, bar_meta = fit_rap_line_to_bars(kokoro, speech_text, profile, trimmed, sr, bpm=bpm)

            out_path = item["audioPath"]
            export_audio_file(trimmed, sr, out_path)
            dur_ms = int(round((len(trimmed) / sr) * 1000.0))
            results[item_id] = {
                "ok": True,
                "engine": hw["engine"],
                "voice": profile["voice"],
                "durationMs": dur_ms,
                "barMeta": bar_meta,
            }
        except Exception as exc:
            results[item_id] = {"ok": False, "error": str(exc)}

    sys.stdout.write(json.dumps({"ok": True, "hw": hw, "results": results}, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()

