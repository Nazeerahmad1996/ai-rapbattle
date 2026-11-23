#!/usr/bin/env python3
"""
Studio 48kHz Stereo CC0 Audio Asset Builder (`scripts/build_audio_assets.py`).

Generates seamless 8-bar / 4-bar 48kHz 16-bit Stereo WAV musical beat beds and foley SFX
into `/audio/beats/` and `/audio/sfx/`:
  - Beats: `rap-90bpm.wav`, `roast-92bpm.wav`, `debate-82bpm.wav`, `poetry-72bpm.wav`, `story-74bpm.wav`
  - SFX:   `impact.wav`, `whoosh.wav`, `crowd-ooh.wav`, `crowd-laugh.wav`,
           `record-scratch.wav`, `round-bell.wav`, `applause.wav`

All generated assets are dedicated to the Public Domain under CC0-1.0 and logged in `/audio/LICENSES.md`.
"""

import math
import os
from pathlib import Path
import numpy as np
import soundfile as sf

SR = 48000
ROOT_DIR = Path(__file__).resolve().parent.parent
BEATS_DIR = ROOT_DIR / "audio" / "beats"
SFX_DIR = ROOT_DIR / "audio" / "sfx"


def midi_to_hz(note: float) -> float:
    return 440.0 * (2.0 ** ((note - 69.0) / 12.0))


def biquad_filter(x: np.ndarray, kind: str, freq: float, q: float = 0.707) -> np.ndarray:
    """Fast vectorized-coefficient Direct Form II Transposed biquad filter (LP, HP, BP)."""
    w0 = 2.0 * math.pi * min(max(freq, 15.0), SR * 0.48) / SR
    cos_w0 = math.cos(w0)
    sin_w0 = math.sin(w0)
    alpha = sin_w0 / (2.0 * max(0.1, q))

    if kind == "lp":
        b0 = (1.0 - cos_w0) * 0.5
        b1 = 1.0 - cos_w0
        b2 = (1.0 - cos_w0) * 0.5
        a0 = 1.0 + alpha
        a1 = -2.0 * cos_w0
        a2 = 1.0 - alpha
    elif kind == "hp":
        b0 = (1.0 + cos_w0) * 0.5
        b1 = -(1.0 + cos_w0)
        b2 = (1.0 + cos_w0) * 0.5
        a0 = 1.0 + alpha
        a1 = -2.0 * cos_w0
        a2 = 1.0 - alpha
    elif kind == "bp":
        b0 = alpha
        b1 = 0.0
        b2 = -alpha
        a0 = 1.0 + alpha
        a1 = -2.0 * cos_w0
        a2 = 1.0 - alpha
    else:
        return x

    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0

    # FFT frequency response application for fast zero-loop filtering on numpy arrays
    n = len(x)
    n_fft = 1 << (n * 2 - 1).bit_length()
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / SR)
    z1 = np.exp(-2j * np.pi * freqs / SR)
    z2 = z1 * z1
    H = (b0 + b1 * z1 + b2 * z2) / (1.0 + a1 * z1 + a2 * z2)
    if x.ndim == 1:
        X = np.fft.rfft(x, n=n_fft)
        return np.fft.irfft(X * H, n=n_fft)[:n].astype(np.float32)
    out = np.zeros_like(x, dtype=np.float32)
    for c in range(x.shape[1]):
        X = np.fft.rfft(x[:, c], n=n_fft)
        out[:, c] = np.fft.irfft(X * H, n=n_fft)[:n]
    return out


def stereo_pan(mono: np.ndarray, pan: float = 0.0) -> np.ndarray:
    """Constant-power stereo panning (-1.0 left .. +1.0 right)."""
    angle = (np.clip(pan, -1.0, 1.0) + 1.0) * (math.pi / 4.0)
    left = mono * math.cos(angle)
    right = mono * math.sin(angle)
    return np.stack([left, right], axis=1).astype(np.float32)


def add_wrapped_stereo(buf: np.ndarray, clip: np.ndarray, start_idx: int):
    """Add a stereo clip into a circular loop buffer with seamless tail wrap-around."""
    loop_len = buf.shape[0]
    clip_len = clip.shape[0]
    idx = (np.arange(clip_len) + start_idx) % loop_len
    np.add.at(buf, idx, clip)


def apply_stereo_room(stereo: np.ndarray, rt60: float = 0.35, wet: float = 0.16, seed: int = 7) -> np.ndarray:
    """Convolve with a smooth stereo early-reflection + diffuse studio room IR."""
    rng = np.random.default_rng(seed)
    ir_len = int(SR * rt60)
    t = np.arange(ir_len, dtype=np.float32) / SR
    decay = np.exp(-6.91 * t / max(0.08, rt60))
    ir_l = rng.standard_normal(ir_len).astype(np.float32) * decay
    ir_r = rng.standard_normal(ir_len).astype(np.float32) * decay
    # Early reflections (studio walls)
    for delay_ms, gain in [(11, 0.7), (19, -0.5), (29, 0.4), (41, 0.3)]:
        d = int(delay_ms * 0.001 * SR)
        if d < ir_len:
            ir_l[d] += gain
            ir_r[min(ir_len - 1, d + int(0.0006 * SR))] += gain * 0.95
    ir_l = biquad_filter(ir_l, "lp", 5200.0)
    ir_r = biquad_filter(ir_r, "lp", 5200.0)
    ir_l /= max(1e-6, np.sqrt(np.sum(ir_l * ir_l)))
    ir_r /= max(1e-6, np.sqrt(np.sum(ir_r * ir_r)))

    n = stereo.shape[0]
    n_fft = 1 << (n + ir_len - 1).bit_length()
    wet_l = np.fft.irfft(np.fft.rfft(stereo[:, 0], n_fft) * np.fft.rfft(ir_l, n_fft), n_fft)[:n]
    wet_r = np.fft.irfft(np.fft.rfft(stereo[:, 1], n_fft) * np.fft.rfft(ir_r, n_fft), n_fft)[:n]
    out = stereo * (1.0 - wet * 0.35) + np.stack([wet_l, wet_r], axis=1) * wet
    return out.astype(np.float32)


def synth_kick(dur: float = 0.36, f_body: float = 48.0, punch: float = 1.0) -> np.ndarray:
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    # Fast pitch sweep: 210Hz -> 95Hz -> f_body
    freq = f_body + 150.0 * np.exp(-t * 58.0) + 32.0 * np.exp(-t * 14.0)
    phase = np.cumsum(2.0 * np.pi * freq / SR)
    sub = np.sin(phase) * np.exp(-t * 8.2)
    # Audible upper bass harmonic (96-140Hz) for smartphone speakers
    harm = np.tanh(sub * 1.9) * 0.72 + sub * 0.55
    # Beater click transient
    click = np.sin(2.0 * np.pi * 1450.0 * t) * np.exp(-t * 165.0) * 0.28 * punch
    mono = (harm + click) * np.minimum(1.0, np.arange(n) / 18.0)
    return stereo_pan(mono, 0.0)


def synth_snare_clap(rng: np.random.Generator, tight: bool = False) -> np.ndarray:
    dur = 0.24 if tight else 0.30
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    # Dual drum-head modes (186Hz & 332Hz)
    f1 = 186.0 + 95.0 * np.exp(-t * 70.0)
    body = (
        np.sin(np.cumsum(2.0 * np.pi * f1 / SR)) * 0.52
        + np.sin(2.0 * np.pi * 332.0 * t) * 0.26
    ) * np.exp(-t * (28.0 if tight else 22.0))

    # Multi-burst stereo clap + crisp snare wires
    wires_l = biquad_filter(rng.standard_normal(n).astype(np.float32), "bp", 3400.0, q=0.75)
    wires_r = biquad_filter(rng.standard_normal(n).astype(np.float32), "bp", 3700.0, q=0.75)
    clap_env = (
        0.55 * np.exp(-np.maximum(0.0, t - 0.000) * 90.0) * (t >= 0.000)
        + 0.65 * np.exp(-np.maximum(0.0, t - 0.008) * 85.0) * (t >= 0.008)
        + 1.00 * np.exp(-np.maximum(0.0, t - 0.017) * (20.0 if tight else 15.5)) * (t >= 0.017)
    )
    left = np.tanh((body + wires_l * clap_env * 1.15) * 1.35) * 0.65
    right = np.tanh((body + wires_r * clap_env * 1.15) * 1.35) * 0.65
    return np.stack([left, right], axis=1).astype(np.float32)


def synth_808_hat(rng: np.random.Generator, open_hat: bool = False, pan: float = 0.18) -> np.ndarray:
    """Authentic 6-oscillator metallic TR-808 cymbal matrix + crisp air."""
    dur = 0.28 if open_hat else 0.075
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    ratios = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0]
    metal = np.zeros(n, dtype=np.float32)
    for f in ratios:
        metal += np.sign(np.sin(2.0 * np.pi * (f * 6.2) * t))
    metal /= len(ratios)
    noise = rng.standard_normal(n).astype(np.float32) * 0.55
    raw = biquad_filter(metal * 0.55 + noise, "hp", 6800.0, q=0.8)
    decay = 11.5 if open_hat else 58.0
    env = np.minimum(1.0, np.arange(n) / 14.0) * np.exp(-t * decay)
    return stereo_pan(raw * env * 0.42, pan)


def synth_808_bass_note(midi_note: float, dur: float, slide_from: float | None = None) -> np.ndarray:
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    target_f = midi_to_hz(midi_note)
    if slide_from is not None:
        start_f = midi_to_hz(slide_from)
        glide = np.clip(t / 0.065, 0.0, 1.0)
        freq = start_f + (target_f - start_f) * glide
    else:
        freq = np.full(n, target_f, dtype=np.float32)

    phase = np.cumsum(2.0 * np.pi * freq / SR)
    fundamental = np.sin(phase)
    # Warm 2nd & 3rd harmonics so bass translates clearly on laptop & phone speakers
    saturated = np.tanh(fundamental * 1.85 + 0.25 * np.sin(2.0 * phase))
    lp = biquad_filter(saturated.astype(np.float32), "lp", 260.0, q=0.85)
    attack = np.minimum(1.0, np.arange(n) / int(0.008 * SR))
    release = np.minimum(1.0, np.arange(n)[::-1] / int(0.025 * SR))
    sustain = np.exp(-t * 1.45)
    return stereo_pan(lp * attack * release * sustain * 0.48, 0.0)


def synth_chord_pad(midi_notes: list[int], dur: float, bright: float = 1600.0) -> np.ndarray:
    """Warm stereo Rhodes / minor-9th analog pad with detuned L/R chorus (carved around vocal midrange)."""
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    left = np.zeros(n, dtype=np.float32)
    right = np.zeros(n, dtype=np.float32)
    for idx, note in enumerate(midi_notes):
        f_l = midi_to_hz(note - 0.05)
        f_r = midi_to_hz(note + 0.05)
        # Electric piano tine + warm body
        tone_l = np.sin(2.0 * np.pi * f_l * t) + 0.22 * np.sin(2.0 * np.pi * f_l * 2.0 * t) * np.exp(-t * 3.5)
        tone_r = np.sin(2.0 * np.pi * f_r * t) + 0.22 * np.sin(2.0 * np.pi * f_r * 2.0 * t) * np.exp(-t * 3.5)
        left += tone_l / len(midi_notes)
        right += tone_r / len(midi_notes)

    env = np.minimum(1.0, t / 0.035) * np.minimum(1.0, (dur - t) / 0.08) * np.exp(-t * 0.55)
    stereo = np.stack([left * env, right * env], axis=1).astype(np.float32)
    stereo = biquad_filter(stereo, "lp", bright, q=0.75)
    stereo = biquad_filter(stereo, "hp", 160.0, q=0.7)
    return stereo * 0.24


def synth_pluck_bell(midi_note: int, dur: float = 0.42, pan: float = -0.25) -> np.ndarray:
    """Dark hip-hop bell/kalimba motif note."""
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    f = midi_to_hz(midi_note)
    mod = np.sin(2.0 * np.pi * (f * 2.0) * t) * np.exp(-t * 18.0) * 1.1
    sig = np.sin(2.0 * np.pi * f * t + mod) * np.exp(-t * 6.5)
    sig *= np.minimum(1.0, np.arange(n) / 16.0)
    return stereo_pan(sig.astype(np.float32) * 0.16, pan)


def normalize_wav(stereo: np.ndarray, peak_db: float = -2.5) -> np.ndarray:
    peak = float(np.max(np.abs(stereo)))
    if peak < 1e-6:
        return stereo
    target = 10.0 ** (peak_db / 20.0)
    return (stereo * (target / peak)).astype(np.float32)


def build_rap_beat_90bpm() -> np.ndarray:
    """8-bar 90 BPM Dark Arena Boom-Bap / 808 Beat in D minor."""
    bpm = 90.0
    bars = 8
    step_sec = 60.0 / bpm / 4.0  # 16th note
    total_steps = bars * 16
    loop_samples = int(round(total_steps * step_sec * SR))
    buf = np.zeros((loop_samples, 2), dtype=np.float32)
    rng = np.random.default_rng(90901)

    kick = synth_kick(dur=0.38, f_body=46.25, punch=1.1)  # F#1/D1 weight
    snare = synth_snare_clap(rng, tight=False)
    hat_c_l = synth_808_hat(rng, open_hat=False, pan=-0.24)
    hat_c_r = synth_808_hat(rng, open_hat=False, pan=0.24)
    hat_o = synth_808_hat(rng, open_hat=True, pan=0.32)

    # 4-bar chord & bass progression repeated x2 with bar-8 turnaround fill:
    # Bar 1: Dm9 (D2=38) | Bar 2: Bbmaj7 (Bb1=34) | Bar 3: Gm9 (G1=31) | Bar 4: A7b9 (A1=33)
    chords = [
        ([50, 53, 57, 60, 64], 38),
        ([46, 53, 57, 62], 34),
        ([43, 50, 53, 58, 62], 31),
        ([45, 52, 55, 58, 61], 33),
    ]
    bell_motif = [
        (0, 74, -0.3), (3, 77, 0.25), (6, 76, -0.2), (10, 72, 0.3), (14, 69, -0.15)
    ]

    for bar in range(bars):
        chord_notes, bass_root = chords[bar % 4]
        bar_start = int(round(bar * 16 * step_sec * SR))

        # Lush dark minor chord pad
        pad = synth_chord_pad(chord_notes, dur=16 * step_sec, bright=1550.0)
        add_wrapped_stereo(buf, pad, bar_start)

        # Bell counter-melody (subtle, atmospheric)
        for step_off, note, pan in bell_motif:
            if bar % 2 == 1 and step_off == 14:
                note += 3
            pos = int(round((bar * 16 + step_off) * step_sec * SR))
            add_wrapped_stereo(buf, synth_pluck_bell(note, dur=0.45, pan=pan), pos)

        # 808 Sub-bass groove
        bass_hits = [(0, bass_root, 5.5, None), (6, bass_root, 3.5, None), (10, bass_root + 7, 5.0, bass_root)]
        if bar % 4 == 3:
            bass_hits.append((14, bass_root + 12, 2.0, bass_root + 7))
        for st, b_note, dur_steps, slide in bass_hits:
            pos = int(round((bar * 16 + st) * step_sec * SR))
            add_wrapped_stereo(buf, synth_808_bass_note(b_note, dur_steps * step_sec, slide_from=slide), pos)

        for st in range(16):
            # Subtle boom-bap 16th swing on odd 16ths
            swing_sec = (0.014 if st % 2 == 1 else 0.0)
            pos = int(round(((bar * 16 + st) * step_sec + swing_sec) * SR))

            # Kick pattern
            if st in (0, 6, 10) or (bar % 2 == 1 and st == 15) or (bar == 7 and st == 13):
                add_wrapped_stereo(buf, kick * (1.0 if st == 0 else 0.86), pos)

            # Snare on 2 & 4 (steps 4 & 12) + ghost fill at end of bar 4 & 8
            if st in (4, 12):
                add_wrapped_stereo(buf, snare, pos)
            elif bar in (3, 7) and st == 15:
                add_wrapped_stereo(buf, snare * 0.48, pos)

            # Hi-hats + occasional 32nd-note trap roll on step 11 in even bars
            if st == 14:
                add_wrapped_stereo(buf, hat_o * 0.85, pos)
            elif st % 2 == 0:
                add_wrapped_stereo(buf, hat_c_l * (0.95 if st % 4 == 0 else 0.72), pos)
            else:
                add_wrapped_stereo(buf, hat_c_r * 0.48, pos)

            if bar % 2 == 1 and st == 11:
                for sub_r in range(3):
                    r_pos = pos + int(round(sub_r * (step_sec / 3.0) * SR))
                    add_wrapped_stereo(buf, hat_c_l * 0.55, r_pos)

    buf = apply_stereo_room(buf, rt60=0.32, wet=0.14, seed=101)
    return normalize_wav(buf, peak_db=-3.0)


def build_roast_beat_92bpm() -> np.ndarray:
    """8-bar 92 BPM Funky Comedy-Club Bounce Groove."""
    bpm = 92.0
    bars = 8
    step_sec = 60.0 / bpm / 4.0
    loop_samples = int(round(bars * 16 * step_sec * SR))
    buf = np.zeros((loop_samples, 2), dtype=np.float32)
    rng = np.random.default_rng(92921)

    kick = synth_kick(dur=0.28, f_body=55.0, punch=1.2)
    rim_snare = synth_snare_clap(rng, tight=True)
    hat_l = synth_808_hat(rng, open_hat=False, pan=-0.28)
    hat_r = synth_808_hat(rng, open_hat=False, pan=0.28)
    hat_o = synth_808_hat(rng, open_hat=True, pan=-0.3)

    roots = [40, 40, 43, 45]  # E2 funk vamp (Em7 -> G -> A7)
    stabs = [[52, 55, 59, 62], [52, 55, 59, 62], [55, 59, 62, 66], [57, 61, 64, 67]]

    for bar in range(bars):
        root = roots[bar % 4]
        chord = stabs[bar % 4]
        # Syncopated clav/EP stabs on upbeat 16ths (steps 2, 7, 12)
        for st_off in (2, 7, 11):
            pos = int(round((bar * 16 + st_off) * step_sec * SR))
            stab = synth_chord_pad(chord, dur=2.2 * step_sec, bright=2400.0) * 1.25
            add_wrapped_stereo(buf, stab, pos)

        # Bouncy funk bassline
        funk_notes = [(0, root, 2.5), (3, root + 12, 1.5), (6, root, 2.5), (10, root + 7, 2.5), (14, root + 10, 1.8)]
        for st_off, note, d_st in funk_notes:
            pos = int(round((bar * 16 + st_off) * step_sec * SR))
            add_wrapped_stereo(buf, synth_808_bass_note(note, d_st * step_sec) * 0.95, pos)

        for st in range(16):
            swing = 0.018 if st % 2 == 1 else 0.0
            pos = int(round(((bar * 16 + st) * step_sec + swing) * SR))
            if st in (0, 7, 10):
                add_wrapped_stereo(buf, kick, pos)
            if st in (4, 12):
                add_wrapped_stereo(buf, rim_snare, pos)
            if st == 6:
                add_wrapped_stereo(buf, hat_o * 0.7, pos)
            elif st % 2 == 0:
                add_wrapped_stereo(buf, hat_l * 0.85, pos)
            else:
                add_wrapped_stereo(buf, hat_r * 0.5, pos)

    buf = apply_stereo_room(buf, rt60=0.28, wet=0.13, seed=202)
    return normalize_wav(buf, peak_db=-3.0)


def build_debate_beat_82bpm() -> np.ndarray:
    """8-bar 82 BPM Broadcast Tension & Clockwork Pulse."""
    bpm = 82.0
    bars = 8
    step_sec = 60.0 / bpm / 4.0
    loop_samples = int(round(bars * 16 * step_sec * SR))
    buf = np.zeros((loop_samples, 2), dtype=np.float32)
    rng = np.random.default_rng(82821)

    kick = synth_kick(dur=0.32, f_body=50.0, punch=0.75) * 0.75
    tick_l = synth_808_hat(rng, open_hat=False, pan=-0.35) * 0.55
    tick_r = synth_808_hat(rng, open_hat=False, pan=0.35) * 0.55
    chords = [([48, 55, 60, 63], 36), ([44, 51, 56, 60], 32), ([41, 48, 53, 56], 29), ([43, 50, 55, 59], 31)]

    for bar in range(bars):
        c_notes, b_root = chords[bar % 4]
        bar_pos = int(round(bar * 16 * step_sec * SR))
        add_wrapped_stereo(buf, synth_chord_pad(c_notes, dur=16 * step_sec, bright=1250.0) * 1.1, bar_pos)
        add_wrapped_stereo(buf, synth_808_bass_note(b_root, dur=8 * step_sec) * 0.72, bar_pos)
        add_wrapped_stereo(buf, synth_808_bass_note(b_root, dur=8 * step_sec) * 0.68, bar_pos + int(8 * step_sec * SR))

        for st in range(16):
            pos = int(round((bar * 16 + st) * step_sec * SR))
            if st in (0, 8):
                add_wrapped_stereo(buf, kick, pos)
            if st % 2 == 0:
                add_wrapped_stereo(buf, tick_l if (st // 2) % 2 == 0 else tick_r, pos)
            if st in (0, 4, 8, 12):
                arp_note = c_notes[(st // 4) % len(c_notes)] + 12
                add_wrapped_stereo(buf, synth_pluck_bell(arp_note, dur=0.35, pan=(-0.25 if st % 8 == 0 else 0.25)) * 0.7, pos)

    buf = apply_stereo_room(buf, rt60=0.42, wet=0.18, seed=303)
    return normalize_wav(buf, peak_db=-3.5)


def build_poetry_bed_72bpm() -> np.ndarray:
    """4-bar 72 BPM Soft Warm Ambient Lounge Bed (Zero harsh drums!)."""
    bpm = 72.0
    bars = 4
    bar_sec = (60.0 / bpm) * 4.0
    loop_samples = int(round(bars * bar_sec * SR))
    buf = np.zeros((loop_samples, 2), dtype=np.float32)

    chords = [
        ([48, 55, 59, 64, 67], 36),  # Cmaj9
        ([45, 52, 57, 60, 64], 33),  # Am9
        ([41, 48, 53, 57, 60], 29),  # Fmaj9
        ([43, 50, 55, 59, 62], 31),  # G6
    ]
    for bar, (c_notes, b_root) in enumerate(chords):
        pos = int(round(bar * bar_sec * SR))
        add_wrapped_stereo(buf, synth_chord_pad(c_notes, dur=bar_sec * 1.08, bright=1150.0) * 1.35, pos)
        add_wrapped_stereo(buf, synth_808_bass_note(b_root, dur=bar_sec * 0.95) * 0.45, pos)
        # Delicate harp/bell harmonic shimmer on beat 3
        shimmer_pos = pos + int(round(bar_sec * 0.5 * SR))
        add_wrapped_stereo(buf, synth_pluck_bell(c_notes[-1] + 12, dur=1.2, pan=0.25) * 0.55, shimmer_pos)

    buf = apply_stereo_room(buf, rt60=0.75, wet=0.28, seed=404)
    return normalize_wav(buf, peak_db=-4.5)


def build_story_bed_74bpm() -> np.ndarray:
    """4-bar 74 BPM Cinematic Neo-Noir Narrative Underscore."""
    bpm = 74.0
    bars = 4
    bar_sec = (60.0 / bpm) * 4.0
    loop_samples = int(round(bars * bar_sec * SR))
    buf = np.zeros((loop_samples, 2), dtype=np.float32)

    heartbeat = synth_kick(dur=0.4, f_body=43.0, punch=0.45) * 0.52
    chords = [
        ([45, 52, 57, 60], 33),
        ([41, 48, 53, 57], 29),
        ([38, 45, 50, 53], 26),
        ([40, 47, 52, 56], 28),
    ]
    for bar, (c_notes, b_root) in enumerate(chords):
        pos = int(round(bar * bar_sec * SR))
        add_wrapped_stereo(buf, synth_chord_pad(c_notes, dur=bar_sec * 1.06, bright=1350.0) * 1.3, pos)
        add_wrapped_stereo(buf, synth_808_bass_note(b_root, dur=bar_sec * 0.9) * 0.52, pos)
        add_wrapped_stereo(buf, heartbeat, pos)
        add_wrapped_stereo(buf, heartbeat * 0.72, pos + int(round((bar_sec / 8.0) * 3 * SR)))

    buf = apply_stereo_room(buf, rt60=0.65, wet=0.25, seed=505)
    return normalize_wav(buf, peak_db=-4.0)


# ==============================================================================
# FOLEY & ARENA SFX KIT (48 kHz Stereo)
# ==============================================================================
def build_sfx_impact() -> np.ndarray:
    dur = 0.68
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    rng = np.random.default_rng(701)

    freq = 36.0 + 185.0 * np.exp(-t * 42.0) + 45.0 * np.exp(-t * 7.5)
    sub = np.tanh(np.sin(np.cumsum(2.0 * np.pi * freq / SR)) * 2.1) * np.exp(-t * 5.2)
    crack_l = biquad_filter(rng.standard_normal(n).astype(np.float32), "bp", 1800.0, q=0.7) * np.exp(-t * 32.0)
    crack_r = biquad_filter(rng.standard_normal(n).astype(np.float32), "bp", 2150.0, q=0.7) * np.exp(-t * 32.0)
    stereo = np.stack([sub * 0.85 + crack_l * 0.65, sub * 0.85 + crack_r * 0.65], axis=1).astype(np.float32)
    stereo = apply_stereo_room(stereo, rt60=0.45, wet=0.22, seed=702)
    return normalize_wav(stereo, peak_db=-1.5)


def build_sfx_whoosh() -> np.ndarray:
    """Fast Doppler-panned stereo transition whip (0.36s — transitions only)."""
    dur = 0.36
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    p = t / dur
    rng = np.random.default_rng(703)

    noise = rng.standard_normal(n).astype(np.float32)
    # Time-varying resonant sweep via windowed low+band blend
    low = biquad_filter(noise, "bp", 420.0, q=1.1)
    mid = biquad_filter(noise, "bp", 1350.0, q=0.9)
    high = biquad_filter(noise, "bp", 3400.0, q=0.8)
    swept = low * (1.0 - p) + mid * np.sin(np.pi * p) * 1.4 + high * (p ** 1.5)
    env = np.sin(np.pi * (p ** 0.85)) ** 1.8

    # Pan smoothly from Left (-0.85) to Right (+0.85)
    pans = -0.85 + 1.70 * p
    angles = (pans + 1.0) * (math.pi / 4.0)
    stereo = np.stack([swept * env * np.cos(angles), swept * env * np.sin(angles)], axis=1).astype(np.float32)
    return normalize_wav(stereo, peak_db=-2.0)


def build_sfx_round_bell() -> np.ndarray:
    """Authentic multi-partial cast-brass boxing ring bell."""
    dur = 1.25
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    # Measured brass bell inharmonic partials (Hz, weight, decay, stereo spread)
    partials = [
        (698.5, 1.00, 3.1, -0.08),
        (1054.0, 0.72, 4.0, 0.10),
        (1412.0, 0.58, 4.8, -0.14),
        (1895.0, 0.44, 6.2, 0.16),
        (2460.0, 0.32, 8.5, -0.20),
        (3190.0, 0.22, 11.5, 0.22),
        (4120.0, 0.15, 16.0, -0.12),
    ]
    stereo = np.zeros((n, 2), dtype=np.float32)
    for freq, weight, dec, pan in partials:
        # Subtle acoustic beating (+1.8 Hz detuned twin partial)
        wave = (np.sin(2.0 * np.pi * freq * t) + 0.45 * np.sin(2.0 * np.pi * (freq + 1.8) * t)) * 0.7
        sig = wave * weight * np.exp(-t * dec)
        stereo += stereo_pan(sig.astype(np.float32), pan)
    # Metallic hammer strike transient
    strike = np.sin(2.0 * np.pi * 2850.0 * t) * np.exp(-t * 140.0) * 0.45
    stereo += stereo_pan(strike.astype(np.float32), 0.0)
    stereo *= np.minimum(1.0, np.arange(n) / 18.0)[:, None]
    stereo = apply_stereo_room(stereo, rt60=0.45, wet=0.18, seed=704)
    return normalize_wav(stereo, peak_db=-1.8)


def build_sfx_record_scratch() -> np.ndarray:
    """Turntable vinyl chirp & backspin scratch (0.36s)."""
    dur = 0.36
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    p = t / dur
    rng = np.random.default_rng(705)

    # Classic forward-pull-back turntable velocity curve
    vel = np.sin(p * 2.3 * np.pi) * (1.0 + 1.6 * (1.0 - p))
    freq = 240.0 + 1150.0 * np.abs(vel)
    phase = np.cumsum(2.0 * np.pi * freq / SR)
    record_sig = (
        np.sin(phase) * 0.6
        + 0.35 * np.sin(phase * 1.98)
        + 0.22 * np.sign(np.sin(phase * 0.5))
    )
    vinyl_friction = biquad_filter(rng.standard_normal(n).astype(np.float32), "bp", 2400.0, q=1.2) * 0.35
    fader_cut = (np.maximum(0.0, np.sin(np.pi * np.clip(p * 2.0, 0.0, 1.0))) ** 0.4) * (
        1.0 - np.clip((p - 0.82) / 0.18, 0.0, 1.0)
    )
    mono = np.tanh((record_sig + vinyl_friction) * 1.6) * fader_cut
    return normalize_wav(stereo_pan(mono.astype(np.float32), -0.15), peak_db=-2.2)


def synth_vocal_tract_voice(
    dur: float,
    f0_curve: np.ndarray,
    f1: float,
    f2: float,
    f3: float,
    amp_env: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
    """Glottal Rosenberg-pulse + 3-formant vocal tract model for realistic crowd voices."""
    n = int(SR * dur)
    # Vibrato + micro-jitter
    jitter = biquad_filter(rng.standard_normal(n).astype(np.float32), "lp", 12.0) * 3.5
    f0 = np.maximum(65.0, f0_curve + jitter)
    phase = np.mod(np.cumsum(f0 / SR), 1.0)
    # Glottal pulse wave rich in harmonics + breathiness
    glottal = np.where(phase < 0.42, 0.5 * (1.0 - np.cos(np.pi * phase / 0.28)), 0.0).astype(np.float32)
    glottal -= float(np.mean(glottal))
    glottal += rng.standard_normal(n).astype(np.float32) * 0.08

    v1 = biquad_filter(glottal, "bp", f1, q=4.5) * 1.0
    v2 = biquad_filter(glottal, "bp", f2, q=5.5) * 0.65
    v3 = biquad_filter(glottal, "bp", f3, q=6.5) * 0.28
    return (v1 + v2 + v3) * amp_env


def load_kokoro_if_available():
    model_p = ROOT_DIR / "data" / "models" / "kokoro" / "kokoro-v1.0.int8.onnx"
    voices_p = ROOT_DIR / "data" / "models" / "kokoro" / "voices-v1.0.bin"
    if model_p.exists() and voices_p.exists():
        try:
            from kokoro_onnx import Kokoro
            return Kokoro(str(model_p), str(voices_p))
        except Exception:
            return None
    return None


def resample_linear(x: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr or len(x) == 0:
        return x.astype(np.float32)
    dst_len = max(1, int(round(len(x) * dst_sr / src_sr)))
    src_idx = np.linspace(0, len(x) - 1, dst_len, dtype=np.float32)
    return np.interp(src_idx, np.arange(len(x), dtype=np.float32), x).astype(np.float32)


def trim_silence(x: np.ndarray, thresh: float = 0.015) -> np.ndarray:
    idx = np.where(np.abs(x) > thresh)[0]
    if len(idx) == 0:
        return x
    return x[max(0, int(idx[0]) - 120) : min(len(x), int(idx[-1]) + 240)]


def build_sfx_crowd_ooh(kokoro=None) -> np.ndarray:
    """Multi-voice stereo battle-rap crowd 'OOOH!!' reaction on knockout punchline."""
    dur = 1.28
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    rng = np.random.default_rng(706)
    stereo = np.zeros((n, 2), dtype=np.float32)

    if kokoro is not None:
        crowd_cast = [
            ("am_fenrir", "Oooh!", 1.05, -0.78),
            ("am_puck", "Whoa!", 1.15, 0.72),
            ("af_heart", "Ohhh!", 1.02, -0.52),
            ("bm_george", "Ooh!", 0.96, 0.56),
            ("am_onyx", "Damn, ooh!", 1.18, -0.25),
            ("af_bella", "Whoa!", 1.10, 0.34),
            ("am_michael", "Oooh!", 0.92, -0.88),
            ("bf_emma", "Oh!", 1.12, 0.85),
            ("am_liam", "Oooh!", 1.08, -0.12),
            ("af_nova", "Ohhh!", 1.00, 0.18),
        ]
        for v_name, phrase, spd, pan in crowd_cast:
            try:
                wav24, sr24 = kokoro.create(phrase, voice=v_name, speed=spd, lang="en-us")
                clip = resample_linear(trim_silence(np.asarray(wav24, dtype=np.float32)), sr24, SR)
                onset = int(rng.uniform(0.005, 0.13) * SR)
                end_i = min(n, onset + len(clip))
                seg = clip[: max(0, end_i - onset)]
                if len(seg) > 0:
                    fade = np.minimum(1.0, np.arange(len(seg))[::-1] / int(0.12 * SR))
                    stereo[onset:end_i] += stereo_pan(seg * fade * float(rng.uniform(0.45, 0.85)), pan)
            except Exception:
                pass

    # Add 14 low-mid arena crowd voices for stadium fullness
    for _ in range(14):
        onset = float(rng.uniform(0.01, 0.14))
        v_dur = float(rng.uniform(0.62, 1.02))
        base_f0 = float(rng.choice([118, 132, 148, 165, 190, 220])) * float(rng.uniform(0.95, 1.06))
        local_t = np.clip((t - onset) / max(0.2, v_dur), 0.0, 1.0)
        f0_curve = base_f0 * (1.0 + 0.34 * np.sin(np.pi * (local_t ** 0.65)) - 0.16 * local_t)
        active = (t >= onset) & (t <= onset + v_dur)
        env = np.where(active, (np.maximum(0.0, np.sin(np.pi * local_t)) ** 0.75) * np.exp(-local_t * 1.1), 0.0).astype(
            np.float32
        )
        voice = synth_vocal_tract_voice(
            dur,
            f0_curve,
            float(rng.uniform(350.0, 440.0)),
            float(rng.uniform(760.0, 950.0)),
            float(rng.uniform(2350.0, 2700.0)),
            env,
            rng,
        )
        stereo += stereo_pan(voice * 0.42, float(rng.uniform(-0.88, 0.88)))

    macro = np.minimum(1.0, t / 0.025) * np.minimum(1.0, (dur - t) / 0.28)
    stereo *= macro[:, None]
    stereo = apply_stereo_room(stereo, rt60=0.55, wet=0.32, seed=707)
    return normalize_wav(stereo, peak_db=-2.5)


def build_sfx_crowd_laugh(kokoro=None) -> np.ndarray:
    """Multi-voice stereo comedy-club burst laughter reaction for Roast punchlines."""
    dur = 1.42
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    rng = np.random.default_rng(708)
    stereo = np.zeros((n, 2), dtype=np.float32)

    if kokoro is not None:
        laugh_cast = [
            ("am_puck", "Haha ha ha!", 1.18, -0.76),
            ("af_heart", "Hahaha!", 1.14, 0.72),
            ("am_fenrir", "Ha ha ha!", 1.08, -0.45),
            ("af_bella", "Haha, ha!", 1.20, 0.54),
            ("bm_george", "Ha ha!", 1.10, -0.22),
            ("af_nova", "Hahaha!", 1.16, 0.30),
            ("am_liam", "Haha ha!", 1.15, -0.85),
            ("bf_emma", "Ha ha ha!", 1.12, 0.84),
        ]
        for v_name, phrase, spd, pan in laugh_cast:
            try:
                wav24, sr24 = kokoro.create(phrase, voice=v_name, speed=spd, lang="en-us")
                clip = resample_linear(trim_silence(np.asarray(wav24, dtype=np.float32)), sr24, SR)
                onset = int(rng.uniform(0.005, 0.16) * SR)
                end_i = min(n, onset + len(clip))
                seg = clip[: max(0, end_i - onset)]
                if len(seg) > 0:
                    fade = np.minimum(1.0, np.arange(len(seg))[::-1] / int(0.14 * SR))
                    stereo[onset:end_i] += stereo_pan(seg * fade * float(rng.uniform(0.45, 0.85)), pan)
            except Exception:
                pass

    for _ in range(14):
        onset = float(rng.uniform(0.01, 0.16))
        burst_rate = float(rng.uniform(4.4, 6.4))
        base_f0 = float(rng.choice([130, 155, 180, 220, 260])) * float(rng.uniform(0.94, 1.06))
        local_t = np.maximum(0.0, t - onset)
        syllable_pulse = np.maximum(0.0, np.sin(2.0 * np.pi * burst_rate * local_t)) ** 1.7
        macro_env = np.minimum(1.0, local_t / 0.05) * np.exp(-local_t * 1.85) * (t >= onset)
        env = (syllable_pulse * macro_env).astype(np.float32)
        f0_curve = base_f0 * (1.12 - 0.18 * np.clip(local_t, 0.0, 1.0) + 0.08 * syllable_pulse)
        voice = synth_vocal_tract_voice(
            dur,
            f0_curve,
            float(rng.uniform(660.0, 820.0)),
            float(rng.uniform(1220.0, 1560.0)),
            float(rng.uniform(2450.0, 2850.0)),
            env,
            rng,
        )
        stereo += stereo_pan(voice * 0.35, float(rng.uniform(-0.88, 0.88)))

    for _ in range(6):
        c_onset = int(rng.uniform(0.08, 0.65) * SR)
        c_dur = int(0.045 * SR)
        if c_onset + c_dur < n:
            ct = np.arange(c_dur, dtype=np.float32) / SR
            clap = biquad_filter(rng.standard_normal(c_dur).astype(np.float32), "bp", float(rng.uniform(1100, 2200)), q=1.4)
            clap *= np.exp(-ct * 75.0) * 0.22
            stereo[c_onset : c_onset + c_dur] += stereo_pan(clap, float(rng.uniform(-0.8, 0.8)))

    macro = np.minimum(1.0, t / 0.025) * np.minimum(1.0, (dur - t) / 0.30)
    stereo *= macro[:, None]
    stereo = apply_stereo_room(stereo, rt60=0.48, wet=0.30, seed=709)
    return normalize_wav(stereo, peak_db=-2.5)


def build_sfx_applause() -> np.ndarray:
    """Dense stereo theatre/arena multi-clapper applause burst (1.85s)."""
    dur = 1.85
    n = int(SR * dur)
    t = np.arange(n, dtype=np.float32) / SR
    rng = np.random.default_rng(710)
    stereo = np.zeros((n, 2), dtype=np.float32)

    # 38 individual audience clappers with distinct palm resonance (850Hz - 2700Hz) & cadence
    for _ in range(38):
        pan = float(rng.uniform(-0.92, 0.92))
        palm_freq = float(rng.uniform(880.0, 2650.0))
        palm_q = float(rng.uniform(1.1, 2.3))
        interval = float(rng.uniform(0.11, 0.21))
        cursor = float(rng.uniform(0.0, 0.16))
        while cursor < dur - 0.06:
            c_idx = int(cursor * SR)
            c_len = int(0.042 * SR)
            if c_idx + c_len < n:
                ct = np.arange(c_len, dtype=np.float32) / SR
                raw = rng.standard_normal(c_len).astype(np.float32)
                clap = biquad_filter(raw, "bp", palm_freq, q=palm_q) * np.exp(-ct * 85.0)
                stereo[c_idx : c_idx + c_len] += stereo_pan(clap * float(rng.uniform(0.18, 0.42)), pan)
            cursor += interval * float(rng.uniform(0.86, 1.15))

    # Smooth macro swell & fade
    macro = np.minimum(1.0, t / 0.12) * np.minimum(1.0, (dur - t) / 0.55)
    stereo *= macro[:, None]
    stereo = apply_stereo_room(stereo, rt60=0.62, wet=0.32, seed=711)
    return normalize_wav(stereo, peak_db=-2.5)


def main():
    os.makedirs(BEATS_DIR, exist_ok=True)
    os.makedirs(SFX_DIR, exist_ok=True)

    beats = {
        "rap-90bpm.wav": build_rap_beat_90bpm(),
        "roast-92bpm.wav": build_roast_beat_92bpm(),
        "debate-82bpm.wav": build_debate_beat_82bpm(),
        "poetry-72bpm.wav": build_poetry_bed_72bpm(),
        "story-74bpm.wav": build_story_bed_74bpm(),
    }
    for name, audio in beats.items():
        path = BEATS_DIR / name
        sf.write(str(path), audio, SR, subtype="PCM_16")
        print(f"[beat] {name}: {audio.shape[0]/SR:.2f}s, {SR}Hz, {audio.shape[1]}ch")

    kokoro = load_kokoro_if_available()
    sfx = {
        "impact.wav": build_sfx_impact(),
        "whoosh.wav": build_sfx_whoosh(),
        "round-bell.wav": build_sfx_round_bell(),
        "record-scratch.wav": build_sfx_record_scratch(),
        "crowd-ooh.wav": build_sfx_crowd_ooh(kokoro),
        "crowd-laugh.wav": build_sfx_crowd_laugh(kokoro),
        "applause.wav": build_sfx_applause(),
    }
    for name, audio in sfx.items():
        path = SFX_DIR / name
        sf.write(str(path), audio, SR, subtype="PCM_16")
        print(f"[sfx]  {name}: {audio.shape[0]/SR:.2f}s, {SR}Hz, {audio.shape[1]}ch")


if __name__ == "__main__":
    main()
