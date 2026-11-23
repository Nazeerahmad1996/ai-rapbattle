#!/usr/bin/env python3
"""
Sample-Accurate 48 kHz Stereo 3-Bus Stem Assembler (`scripts/mix_buses.py`).

Reads a battle's Timeline V2 JSON + `/audio/beats/` & `/audio/sfx/` WAV kit and renders
three sample-locked 48 kHz Stereo WAV buses in ~0.1s:
  1. `vocals-bus.wav` — Every line stem placed at exact `line.startMs` (with subtle corner stereo stage:
                        Corner A = -0.07, Corner B = +0.07, Judge/Hook = 0.00)
  2. `music-bus.wav`  — Mode beat bed looped seamlessly from `beatGrid.offsetMs` (with attenuated cold-open
                        bed, smooth pre-punchline `beat-dropout` cuts, and clean ending fade)
  3. `sfx-bus.wav`    — Every `sfxCues[]` asset (`impact`, `whoosh`, `round-bell`, `record-scratch`,
                        `crowd-ooh`, `crowd-laugh`, `applause`) placed at exact `cue.startMs` & `cue.gainDb`
"""

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import numpy as np
import soundfile as sf

SR = 48000
ROOT_DIR = Path(__file__).resolve().parent.parent
BEATS_DIR = ROOT_DIR / "audio" / "beats"
SFX_DIR = ROOT_DIR / "audio" / "sfx"

BEAT_FILES = {
    "rap": "rap-90bpm.wav",
    "roast": "roast-92bpm.wav",
    "debate": "debate-82bpm.wav",
    "poetry": "poetry-72bpm.wav",
    "story": "story-74bpm.wav",
}


def load_audio_48k_stereo(path: str) -> np.ndarray | None:
    if not path or not os.path.exists(path):
        return None
    try:
        data, sr = sf.read(path, dtype="float32")
        if sr == SR:
            if data.ndim == 1:
                return np.stack([data, data], axis=1)
            if data.shape[1] == 1:
                return np.repeat(data, 2, axis=1)
            if data.shape[1] == 2:
                return data
    except Exception:
        pass

    fd, tmp_wav = tempfile.mkstemp(suffix=".wav", prefix="bus48k_")
    os.close(fd)
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", path, "-ar", str(SR), "-ac", "2", "-f", "wav", tmp_wav,
            ],
            check=True,
        )
        data, _ = sf.read(tmp_wav, dtype="float32")
        if data.ndim == 1:
            data = np.stack([data, data], axis=1)
        return data[:, :2]
    except Exception:
        return None
    finally:
        try:
            os.remove(tmp_wav)
        except OSError:
            pass


def apply_pan_balance(stereo: np.ndarray, pan: float = 0.0) -> np.ndarray:
    if abs(pan) < 1e-4:
        return stereo
    mono = 0.5 * (stereo[:, 0] + stereo[:, 1])
    angle = (np.clip(pan, -1.0, 1.0) + 1.0) * (math.pi / 4.0)
    return np.stack([mono * math.cos(angle) * 1.414, mono * math.sin(angle) * 1.414], axis=1).astype(np.float32)


def main():
    parser = argparse.ArgumentParser(description="Assemble 48kHz Stereo Vocals, Music & SFX Buses")
    parser.add_argument("--spec", required=True, help="Path to JSON mix spec")
    args = parser.parse_args()

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    tl = spec["timelineV2"]
    out_dir = Path(spec["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    enable_beat = bool(spec.get("beat", True))

    total_ms = int(tl["totalDurationMs"])
    total_samples = max(SR, int(round((total_ms / 1000.0) * SR)))

    vocals_bus = np.zeros((total_samples, 2), dtype=np.float32)
    music_bus = np.zeros((total_samples, 2), dtype=np.float32)
    sfx_bus = np.zeros((total_samples, 2), dtype=np.float32)

    # 1. VOCALS BUS (Sample-accurate placement + subtle L/R corner separation)
    placed_lines = 0
    for line in tl.get("lines", []):
        ap = line.get("audioPath")
        clip = load_audio_48k_stereo(ap)
        if clip is None or len(clip) == 0:
            raise ValueError(f"Missing or unreadable vocal stem: {line.get('id', ap)}")

        start_ms = float(line.get("startMs", 0))
        clip_end_ms = float(line.get("clipEndMs", line.get("endMs", start_ms + len(clip) * 1000.0 / SR)))
        max_len = max(1, int(round(((clip_end_ms - start_ms) / 1000.0) * SR)))
        if len(clip) > max_len:
            clip = clip[:max_len].copy()
            fade = min(len(clip) // 4, int(0.025 * SR))
            if fade > 2:
                clip[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)[:, None]

        role = line.get("role") or line.get("side") or "judge"
        pan = -0.07 if role == "a" else (0.07 if role == "b" else 0.0)
        panned = apply_pan_balance(clip, pan)

        raw_start = int(round((start_ms / 1000.0) * SR))
        if raw_start < 0:
            panned = panned[-raw_start:]
        s_idx = max(0, raw_start)
        e_idx = min(total_samples, s_idx + len(panned))
        if e_idx > s_idx:
            vocals_bus[s_idx:e_idx] += panned[: e_idx - s_idx]
            placed_lines += 1

    # 2. MUSIC BUS (Seamless looped mode beat + cold-open contour + pre-punchline beat drop-outs)
    mode = tl.get("mode", "rap")
    beat_wav = BEATS_DIR / BEAT_FILES.get(mode, "rap-90bpm.wav")
    if enable_beat and beat_wav.exists():
        loop_clip = load_audio_48k_stereo(str(beat_wav))
        if loop_clip is not None and len(loop_clip) > 0:
            beat_origin_ms = float(tl.get("beatGrid", {}).get("offsetMs", 0.0))
            origin_idx = min(total_samples, max(0, int(round((beat_origin_ms / 1000.0) * SR))))

            # Fill pre-drop intro with low-level atmospheric tease (-9 dB) so Frame 0 has texture
            for idx in range(0, origin_idx, len(loop_clip)):
                chunk = min(len(loop_clip), origin_idx - idx)
                music_bus[idx : idx + chunk] = loop_clip[:chunk] * 0.34

            # Drop the beat right on Beat 1 at `beatGrid.offsetMs`!
            cursor = origin_idx
            while cursor < total_samples:
                chunk = min(len(loop_clip), total_samples - cursor)
                music_bus[cursor : cursor + chunk] = loop_clip[:chunk]
                cursor += chunk

            # Apply smooth 18ms cosine-ramped Pre-Punchline Beat Drop-Outs!
            ramp_n = int(0.018 * SR)
            for ev in tl.get("events", []):
                if ev.get("type") == "beat-dropout":
                    d_start = max(0, int(round((float(ev["startMs"]) / 1000.0) * SR)))
                    d_end = min(total_samples, int(round((float(ev["endMs"]) / 1000.0) * SR)))
                    if d_end > d_start + ramp_n * 2:
                        env = np.full(d_end - d_start, 0.04, dtype=np.float32)  # -28 dB drop-out
                        env[:ramp_n] = np.linspace(1.0, 0.04, ramp_n, dtype=np.float32)
                        env[-ramp_n:] = np.linspace(0.04, 1.0, ramp_n, dtype=np.float32)
                        music_bus[d_start:d_end] *= env[:, None]

            # Clean fade during loop-bridge tail so loop wraps cleanly
            tail_fade = min(total_samples // 6, int(0.32 * SR))
            if tail_fade > 2:
                music_bus[-tail_fade:] *= np.linspace(1.0, 0.0, tail_fade, dtype=np.float32)[:, None]

    # 3. SFX BUS (Sound Hierarchy: Motivated SFX placed at exact timeline timestamps)
    sfx_cache: dict[str, np.ndarray | None] = {}
    placed_sfx = 0
    for cue in tl.get("sfxCues", []):
        sfx_id = str(cue.get("sfxId", "")).strip()
        if not sfx_id:
            continue
        if sfx_id not in sfx_cache:
            sfx_cache[sfx_id] = load_audio_48k_stereo(str(SFX_DIR / f"{sfx_id}.wav"))
        clip = sfx_cache[sfx_id]
        if clip is None or len(clip) == 0:
            continue

        gain_db = float(cue.get("gainDb", -3.0))
        lin_gain = 10.0 ** (gain_db / 20.0)
        s_idx = max(0, int(round((float(cue.get("startMs", 0)) / 1000.0) * SR)))
        e_idx = min(total_samples, s_idx + len(clip))
        if e_idx > s_idx:
            sfx_bus[s_idx:e_idx] += clip[: e_idx - s_idx] * lin_gain
            placed_sfx += 1

    vox_path = out_dir / "vocals-bus.wav"
    mus_path = out_dir / "music-bus.wav"
    sfx_path = out_dir / "sfx-bus.wav"
    # Summation may exceed 0 dBFS. Float buses preserve those peaks for the
    # master limiter; clipping each bus here would irreversibly distort them.
    sf.write(str(vox_path), vocals_bus, SR, subtype="FLOAT")
    sf.write(str(mus_path), music_bus, SR, subtype="FLOAT")
    sf.write(str(sfx_path), sfx_bus, SR, subtype="FLOAT")

    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "placedLines": placed_lines,
                "busPeakDbfs": {name: round(20 * math.log10(max(1e-9, float(np.max(np.abs(bus))))), 3)
                                 for name, bus in [("vocals", vocals_bus), ("music", music_bus), ("sfx", sfx_bus)]},
                "placedSfx": placed_sfx,
                "vocalsBus": str(vox_path),
                "musicBus": str(mus_path),
                "sfxBus": str(sfx_path),
            }
        )
        + "\n"
    )


if __name__ == "__main__":
    main()

