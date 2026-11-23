#!/usr/bin/env python3
"""
Phase 5 QA Sensor, Frame Extractor & Contact Sheet Builder (`scripts/qa_review_sensor.py`).

Measures final encoded freezes, stream format, cadence, duration, audio loudness,
true peak, and final-mix Whisper script match. Checks saved DOM layout samples
and planned caption timings against forced-aligned source stems. These source
timings are not an independent acoustic alignment of the exported mix. Loudness
range and source breathing gaps are advisory. Unavailable mandatory evidence
cannot approve an export.
Scene-change gaps are editorial diagnostics: smooth motion can continue without
a cut and does not count as a static freeze.

Builds annotated diagnostic contact sheets:
  - `contact-sheet-intro.png`     (t = 0, 0.5, 1, 1.5, 2, 3, 4, 5s)
  - `contact-sheet-punchlines.png` (±3 frames around every punchline impact)
  - `contact-sheet-transitions.png` (speaker switch whip-pans & round drops)
  - `contact-sheet-ending.png`    (vote-cta, winner verdict, loop-bridge over final 3s)
"""

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw, ImageFont

# Import verify_mix_intelligibility from align_words
from align_words import verify_mix_intelligibility


def select_timeline(manifest: dict, aspect: str) -> dict:
    return (manifest.get('shortsTimelineV2') if aspect == '9:16' else None) or manifest.get('timelineV2') or {}


def probe_media(media_path: str) -> dict:
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', media_path,
    ], text=True, timeout=20))


def rate(value):
    try:
        numerator, denominator = str(value).split('/')
        return float(numerator) / float(denominator)
    except (ValueError, ZeroDivisionError):
        return 0.0


def validate_export(probe: dict, aspect: str, tl: dict) -> dict:
    videos = [s for s in probe.get('streams', []) if s.get('codec_type') == 'video']
    audios = [s for s in probe.get('streams', []) if s.get('codec_type') == 'audio']
    video, audio = (videos or [{}])[0], (audios or [{}])[0]
    width, height = (1080, 1920) if aspect == '9:16' else (1920, 1080)
    expected_fps = float(tl.get('fps') or 30)
    duration = float(video.get('duration') or probe.get('format', {}).get('duration') or 0)
    audio_duration = float(audio.get('duration') or 0)
    expected_duration = float(tl.get('totalDurationMs') or 0) / 1000
    frame_count = int(video.get('nb_frames') or 0)
    expected_frames = int(tl.get('totalFrames') or math.ceil(expected_duration * expected_fps))
    return {
        'native_h264_dimensions': len(videos) == 1 and video.get('codec_name') == 'h264' and video.get('width') == width and video.get('height') == height,
        'cfr_rate_and_frame_count': expected_fps in (30, 60) and abs(rate(video.get('avg_frame_rate')) - expected_fps) < .001 and abs(rate(video.get('r_frame_rate')) - expected_fps) < .001 and frame_count == expected_frames and expected_frames > 0,
        'duration_matches_timeline': expected_duration > 0 and abs(duration - expected_duration) <= 1 / expected_fps + .025,
        'audio_48khz_stereo_aac': len(audios) == 1 and audio.get('codec_name') == 'aac' and int(audio.get('sample_rate') or 0) == 48000 and audio.get('channels') == 2,
        'audio_video_duration_agree': bool(audios) and abs(audio_duration - duration) <= .08,
    }


def validate_caption_schedule(tl: dict) -> dict:
    words, pages, lines = tl.get('words') or [], tl.get('captionPages') or [], tl.get('lines') or []
    spoken_lines = [line for line in lines if str(line.get('text') or '').strip()]
    return {
        'caption_pages_present': bool(words) and bool(pages) and all(page.get('words') for page in pages),
        'forced_source_alignment_present': bool(spoken_lines) and all(line.get('alignmentSource') == 'forced' and line.get('words') for line in spoken_lines),
        'planned_highlight_lead_0_to_2_frames': bool(words) and all(isinstance(word.get('leadFrames'), (int, float)) and 0 <= word['leadFrames'] <= 2.05 for word in words),
        'zero_avoidable_function_word_page_ends': bool(pages) and not any(page.get('endsOnFunctionWord') and not page.get('functionWordUnavoidable') for page in pages),
    }


def validate_packet_cadence(timestamps: list[float], fps: float, expected_frames: int) -> dict:
    timestamps = sorted(timestamps)
    gaps = [right - left for left, right in zip(timestamps, timestamps[1:])]
    valid = fps > 0 and len(timestamps) == expected_frames and bool(gaps) and all(math.isfinite(gap) and abs(gap - 1 / fps) < .000003 for gap in gaps)
    return {'ok': valid, 'packetCount': len(timestamps), 'maxFrameGapMs': round(max(gaps) * 1000, 4) if gaps else None}


def measure_packet_cadence(media_path: str, fps: float, expected_frames: int) -> dict:
    try:
        data = json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_packets',
            '-show_entries', 'packet=pts_time', '-of', 'json', media_path,
        ], text=True, timeout=30))
        return validate_packet_cadence([float(packet['pts_time']) for packet in data.get('packets', [])], fps, expected_frames)
    except Exception as error:
        return {'ok': False, 'error': str(error)}


def get_video_duration_sec(media_path: str) -> float:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        media_path,
    ]
    try:
        out = subprocess.check_output(cmd, text=True, timeout=10).strip()
        return float(out)
    except Exception:
        raise RuntimeError('Unable to measure media duration')


def extract_frame_at_sec(media_path: str, sec: float, out_png: str, width: int = 540, height: int = 960):
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{sec:.3f}",
        "-i", media_path,
        "-vframes", "1",
        "-vf", f"scale={width}:{height}",
        out_png,
    ]
    subprocess.run(cmd, check=True, timeout=15)


def measure_empty_dark_space_pct(image_path: str) -> float:
    """Measure percentage of 32x32 pixel blocks whose mean luma is < 14 (dead black empty space)."""
    try:
        im = Image.open(image_path).convert("L")
        w, h = im.size
        arr = np.array(im, dtype=np.float32)
        bw, bh = 32, 32
        n_x = w // bw
        n_y = h // bh
        if n_x == 0 or n_y == 0:
            return 0.0
        cropped = arr[: n_y * bh, : n_x * bw]
        blocks = cropped.reshape(n_y, bh, n_x, bw).mean(axis=(1, 3))
        dark_blocks = np.sum(blocks < 14.0)
        total_blocks = blocks.size
        return round(float(dark_blocks / total_blocks) * 100.0, 2)
    except Exception:
        raise RuntimeError('Unable to measure extracted frame luminance')


def measure_visual_change_intervals(media_path: str, total_sec: float, extra_event_times: list[float] = None) -> tuple[float, float, list[float]]:
    """
    Measure encoded-pixel changes. Planned timeline events cannot prove that a
    visual change actually appeared in the export and never count as detections.
    Returns: (max_gap_first_5s, max_gap_overall, [cut_timestamps])
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats",
        "-i", media_path,
        "-vf", "select='gt(scene,0.02)',metadata=print",
        "-f", "null", "-",
    ]
    cuts = [0.0]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=True)
        out = f"{proc.stdout}\n{proc.stderr}"
        for line in out.splitlines():
            m = re.search(r"pts_time:(\d+(?:\.\d+)?)", line)
            if m:
                t = float(m.group(1))
                if t > cuts[-1] + 0.15:
                    cuts.append(round(t, 3))
    except Exception as error:
        raise RuntimeError('Encoded visual change measurement failed') from error

    cuts.append(round(total_sec, 3))
    cuts = sorted(list(set(cuts)))

    max_gap_5s = 0.0
    max_gap_overall = 0.0
    for i in range(len(cuts) - 1):
        gap = cuts[i + 1] - cuts[i]
        if gap > max_gap_overall:
            max_gap_overall = gap
        if cuts[i] < 5.0:
            sub_end = min(5.0, cuts[i + 1])
            sub_gap = sub_end - cuts[i]
            if sub_gap > max_gap_5s:
                max_gap_5s = sub_gap

    return round(max_gap_5s, 3), round(max_gap_overall, 3), cuts


def measure_freeze_intervals(media_path: str, total_sec: float, min_duration_sec: float = .5, noise_db: float = -60) -> dict:
    """Measure freezes independently of hard cuts using encoded pixel differences.

    FFmpeg's filter compares mean absolute frame differences with a noise floor.
    The -60 dB tolerance ignores insignificant codec noise while preserving small
    camera moves. A freeze_start without freeze_end extends to media EOF.
    Primary reference: https://ffmpeg.org/ffmpeg-filters.html#freezedetect
    """
    cmd = ['ffmpeg', '-hide_banner', '-nostats', '-i', media_path, '-an',
           '-vf', f'freezedetect=noise={noise_db}dB:duration={min_duration_sec}', '-f', 'null', '-']
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=True)
    except Exception as error:
        raise RuntimeError('Encoded freeze measurement failed') from error
    intervals = []
    active_start = None
    number = r'([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)'
    for line in (proc.stdout + '\n' + proc.stderr).splitlines():
        match = re.search(r'lavfi\.freezedetect\.freeze_(start|end):\s*' + number, line)
        if not match:
            continue
        kind, timestamp = match.group(1), float(match.group(2))
        if not math.isfinite(timestamp):
            raise ValueError('Non-finite freeze timestamp')
        if kind == 'start':
            if active_start is not None:
                raise ValueError('Freeze start without preceding end')
            active_start = max(0, timestamp)
        elif active_start is not None:
            intervals.append({'startSec': active_start, 'endSec': min(total_sec, timestamp)})
            active_start = None
        else:
            raise ValueError('Freeze end without preceding start')
    if active_start is not None:
        intervals.append({'startSec': active_start, 'endSec': total_sec})
    if any(interval['endSec'] < interval['startSec'] for interval in intervals):
        raise ValueError('Invalid freeze interval')
    max_intro = max((max(0, min(5, interval['endSec']) - interval['startSec']) for interval in intervals), default=0)
    max_overall = max((interval['endSec'] - interval['startSec'] for interval in intervals), default=0)
    return {'maxFreezeFirst5sSec': round(max_intro, 3), 'maxFreezeOverallSec': round(max_overall, 3),
            'intervals': intervals, 'noiseToleranceDb': noise_db, 'minimumDetectionSec': min_duration_sec,
            'method': 'FFmpeg freezedetect on decoded final MP4; mean absolute frame difference',
            'reference': 'https://ffmpeg.org/ffmpeg-filters.html#freezedetect'}


def measure_ebur128(media_path: str) -> dict:
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats",
        "-i", media_path,
        "-af", "ebur128=peak=true",
        "-f", "null", "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90, check=True)
        log = f"{proc.stdout}\n{proc.stderr}"
        summary_idx = log.rfind("Summary:") if "Summary:" in log else -1
        tail = log[summary_idx:] if summary_idx >= 0 else log

        def get_val(pattern, default=0.0):
            m = re.search(pattern, tail)
            if not m:
                raise ValueError('Missing EBU R128 measurement: ' + pattern)
            return float(m.group(1))

        return {
            "integratedLufs": round(get_val(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", -24.0), 2),
            "loudnessRangeLu": round(get_val(r"LRA:\s*(-?\d+(?:\.\d+)?)\s*LU", 0.0), 2),
            "truePeakDbtp": round(get_val(r"Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS", 0.0), 2),
        }
    except Exception as e:
        return {"error": str(e), "integratedLufs": -99.0, "loudnessRangeLu": 0.0, "truePeakDbtp": 0.0}


def measure_silences(media_path: str, min_duration_sec: float = 0.25) -> list[dict]:
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats",
        "-i", media_path,
        "-af", f"silencedetect=noise=-36dB:d={min_duration_sec}",
        "-f", "null", "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        log = f"{proc.stdout}\n{proc.stderr}"
        gaps = []
        for m in re.finditer(r"silence_end:\s*(\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)", log):
            end_s = float(m.group(1))
            dur_s = float(m.group(2))
            gaps.append({"startSec": round(end_s - dur_s, 3), "endSec": round(end_s, 3), "durSec": round(dur_s, 3)})
        return gaps
    except Exception:
        return []


def create_contact_sheet(
    frame_specs: list[tuple[str, str]],
    out_sheet_path: str,
    cols: int = 4,
    thumb_w: int = 270,
    thumb_h: int = 480,
    header_title: str = "BOTBRAWL DIAGNOSTIC CONTACT SHEET",
):
    """
    Compose an array of `[(image_path, label_text)]` into a high-res diagnostic contact sheet.
    """
    valid = [item for item in frame_specs if os.path.exists(item[0])]
    if not valid:
        return None

    rows = math.ceil(len(valid) / cols)
    sheet_w = cols * thumb_w + (cols + 1) * 16
    header_h = 60
    sheet_h = rows * thumb_h + (rows + 1) * 16 + header_h

    sheet = Image.new("RGB", (sheet_w, sheet_h), color=(14, 12, 22))
    draw = ImageDraw.Draw(sheet)

    # Header banner
    draw.rectangle([(0, 0), (sheet_w, header_h)], fill=(22, 19, 34))
    draw.text((20, 18), header_title, fill=(213, 251, 70))

    for idx, (img_p, label) in enumerate(valid):
        r = idx // cols
        c = idx % cols
        x = 16 + c * (thumb_w + 16)
        y = header_h + 16 + r * (thumb_h + 16)

        try:
            im = Image.open(img_p).resize((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            sheet.paste(im, (x, y))
            # Border
            draw.rectangle([(x, y), (x + thumb_w, y + thumb_h)], outline=(70, 60, 95), width=2)
            # Label strip at bottom of thumb
            draw.rectangle([(x, y + thumb_h - 32), (x + thumb_w, y + thumb_h)], fill=(10, 8, 16))
            draw.text((x + 8, y + thumb_h - 26), label, fill=(255, 255, 255))
        except Exception:
            pass

    Path(out_sheet_path).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_sheet_path, "PNG")
    return out_sheet_path


def main():
    parser = argparse.ArgumentParser(description="BotBrawl Comprehensive Review Sensor & Contact Sheet Builder")
    parser.add_argument("--video", required=True, help="Path to rendered MP4 video (9:16 Shorts or 16:9)")
    parser.add_argument("--manifest", required=True, help="Path to battle manifest.json")
    parser.add_argument("--script", help="Path to full battle script text for Whisper intelligibility check")
    parser.add_argument("--out-dir", required=True, help="Directory to save contact sheets and review JSON")
    parser.add_argument("--skip-whisper", action="store_true", help="Skip Whisper intelligibility check")
    parser.add_argument('--aspect', choices=['16:9', '9:16'], help='Requested export aspect')
    args = parser.parse_args()

    video_path = args.video
    if not os.path.exists(video_path):
        sys.stderr.write(f"Video file not found: {video_path}\n")
        sys.exit(1)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    probe = probe_media(video_path)
    video_stream = next((stream for stream in probe.get('streams', []) if stream.get('codec_type') == 'video'), {})
    aspect = args.aspect or ('9:16' if video_stream.get('height', 0) > video_stream.get('width', 0) else '16:9')
    tl = select_timeline(manifest, aspect)
    if not tl or not tl.get('lines'):
        raise ValueError('No canonical timeline with spoken lines for requested aspect')
    sample_width, sample_height = (540, 960) if aspect == '9:16' else (960, 540)

    total_sec = get_video_duration_sec(video_path)
    fps = tl.get("fps", 30)
    cadence = measure_packet_cadence(video_path, fps, int(tl.get('totalFrames') or math.ceil(total_sec * fps)))

    # 1. Encoded-pixel cadence; do not insert manifest events as synthetic detections.
    max_gap_5s, max_gap_overall, cut_times = measure_visual_change_intervals(
        video_path, total_sec
    )
    freezes = measure_freeze_intervals(video_path, total_sec)

    # 2. Extract Key Diagnostic Frames
    tmp_frames_dir = Path(tempfile.mkdtemp(prefix="qa_frames_"))
    intro_specs = []
    punch_specs = []
    trans_specs = []
    ending_specs = []
    all_dark_pcts = []

    try:
        # A. Intro Hook frames: t = 0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0s
        intro_times = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0]
        for t in intro_times:
            if t <= total_sec:
                fp = str(tmp_frames_dir / f"intro_{t:.1f}s.png")
                extract_frame_at_sec(video_path, t, fp, sample_width, sample_height)
                d_pct = measure_empty_dark_space_pct(fp)
                all_dark_pcts.append(d_pct)
                intro_specs.append((fp, f"t={t:.1f}s (dark={d_pct:.1f}%)"))

        # B. Punchline frames: ±3 frames around each punchline event
        punch_events = [e for e in tl.get("events", []) if e.get("type") == "punchline"]
        for p_idx, p_ev in enumerate(punch_events):
            p_sec = float(p_ev["startMs"]) / 1000.0
            for f_off, f_label in [(-3, "-3f"), (0, "HIT"), (3, "+3f")]:
                sample_s = max(0.0, min(total_sec - 0.05, p_sec + f_off / fps))
                fp = str(tmp_frames_dir / f"punch_{p_idx}_{f_label}.png")
                extract_frame_at_sec(video_path, sample_s, fp, sample_width, sample_height)
                d_pct = measure_empty_dark_space_pct(fp)
                all_dark_pcts.append(d_pct)
                punch_specs.append((fp, f"P#{p_idx+1} {f_label} t={sample_s:.2f}s"))

        # C. Transition frames: speaker switches, VS slam, round start
        trans_events = [e for e in tl.get("events", []) if e.get("type") in ("vs-slam", "speaker-switch", "round-start")]
        for tr_idx, tr_ev in enumerate(trans_events):
            tr_sec = float(tr_ev["startMs"]) / 1000.0
            fp = str(tmp_frames_dir / f"trans_{tr_idx}.png")
            extract_frame_at_sec(video_path, tr_sec, fp, sample_width, sample_height)
            d_pct = measure_empty_dark_space_pct(fp)
            all_dark_pcts.append(d_pct)
            trans_specs.append((fp, f"{tr_ev['type']} t={tr_sec:.2f}s"))

        # D. Ending frames: vote CTA, verdict slam, loop bridge across final 3.5s
        end_times = [
            max(0.0, total_sec - 3.2),
            max(0.0, total_sec - 2.2),
            max(0.0, total_sec - 1.2),
            max(0.0, total_sec - 0.2),
        ]
        for e_idx, e_s in enumerate(end_times):
            fp = str(tmp_frames_dir / f"end_{e_idx}.png")
            extract_frame_at_sec(video_path, e_s, fp, sample_width, sample_height)
            d_pct = measure_empty_dark_space_pct(fp)
            all_dark_pcts.append(d_pct)
            ending_specs.append((fp, f"Ending t={e_s:.2f}s (dark={d_pct:.1f}%)"))

        # Render high-res diagnostic contact sheets
        sheet_intro = create_contact_sheet(
            intro_specs,
            str(out_dir / "contact-sheet-intro.png"),
            cols=4,
            header_title="BOTBRAWL HOOK & ROUND 1 CADENCE (t=0s to 5s)",
            thumb_w=270 if aspect == '9:16' else 480,
            thumb_h=480 if aspect == '9:16' else 270,
        )
        sheet_punch = create_contact_sheet(
            punch_specs,
            str(out_dir / "contact-sheet-punchlines.png"),
            cols=3,
            header_title="BOTBRAWL PUNCHLINE REACTION & SHAKE MATRIX (±3 FRAMES)",
            thumb_w=270 if aspect == '9:16' else 480,
            thumb_h=480 if aspect == '9:16' else 270,
        )
        sheet_trans = create_contact_sheet(
            trans_specs,
            str(out_dir / "contact-sheet-transitions.png"),
            cols=4,
            header_title="BOTBRAWL SCENE & SPEAKER WHIP TRANSITIONS",
            thumb_w=270 if aspect == '9:16' else 480,
            thumb_h=480 if aspect == '9:16' else 270,
        )
        sheet_ending = create_contact_sheet(
            ending_specs,
            str(out_dir / "contact-sheet-ending.png"),
            cols=4,
            header_title="BOTBRAWL VOTE CTA, WINNER SLAM & LOOP BRIDGE",
            thumb_w=270 if aspect == '9:16' else 480,
            thumb_h=480 if aspect == '9:16' else 270,
        )
    finally:
        # Note: clean temporary frame slice PNGs after contact sheets are stitched
        for f in tmp_frames_dir.glob("*.png"):
            try:
                f.unlink()
            except OSError:
                pass
        try:
            tmp_frames_dir.rmdir()
        except OSError:
            pass

    # 3. Audio Loudness & Silences (Master 48 kHz Stereo Mix Bus)
    # Encoding can introduce intersample overshoot: measure the actual uploaded AAC.
    ebur128 = measure_ebur128(video_path)
    silences = measure_silences(video_path, min_duration_sec=0.25)
    mean_dark_space_pct = round(float(np.mean(all_dark_pcts)), 2) if all_dark_pcts else 0.0

    # 4. Whisper Intelligibility on final mix
    whisper_res = {"ok": False, "wordMatchPct": None, "skipped": True}
    if not args.skip_whisper:
        script_text = ""
        if args.script and os.path.exists(args.script):
            script_text = Path(args.script).read_text(encoding="utf-8")
        elif "lines" in tl:
            spoken_words = []
            for line in tl["lines"]:
                line_words = line.get("words", [])
                clip_end = line.get("clipEndMs")
                if clip_end and line_words:
                    line_words = [w for w in line_words if w.get("endMs", float('inf')) <= clip_end]
                if line_words:
                    spoken_words.append(" ".join(w.get("text", "") for w in line_words))
                elif line.get("text"):
                    spoken_words.append(line["text"])
            script_text = " ".join(spoken_words)

        if script_text:
            whisper_res = verify_mix_intelligibility(
                model_name="large-v3",
                media_path=video_path,
                script_text=script_text,
                language=manifest.get("battle", {}).get("config", {}).get("language", "English"),
            )

    # 5. Caption timing & Function-word endings check from manifest.timelineV2
    caption_pages = tl.get("captionPages", [])
    calibrated_words = tl.get("words", [])
    function_word_violations = [
        p for p in caption_pages if p.get("endsOnFunctionWord") and not p.get("functionWordUnavoidable")
    ]
    lagging_words = [w for w in calibrated_words if float(w.get("leadFrames", 0.0)) < -0.001]
    excess_lead_words = [w for w in calibrated_words if float(w.get("leadFrames", 0.0)) > 2.05]

    alignment_drift = tl.get("alignmentDrift", {})

    telemetry_path = Path(video_path).parent / ('layout-telemetry-9x16.json' if aspect == '9:16' else 'layout-telemetry-16x9.json')
    telemetry = []
    telemetry_error = None
    try:
        telemetry = json.loads(telemetry_path.read_text(encoding='utf-8'))
        if not isinstance(telemetry, list) or not telemetry:
            raise ValueError('No layout samples')
        if telemetry_path.stat().st_mtime < Path(video_path).stat().st_mtime - 1:
            raise ValueError('Layout samples predate this export')
        if not all(isinstance(sample.get('safeZoneViolations'), list) and isinstance(sample.get('textOverflows'), list) for sample in telemetry):
            raise ValueError('Incomplete layout sample')
    except Exception as error:
        telemetry_error = str(error)
    layout_valid = bool(telemetry) and telemetry_error is None
    safe_violations = [violation for sample in telemetry if isinstance(sample, dict) for violation in sample.get('safeZoneViolations', [])]
    overflow_violations = [violation for sample in telemetry if isinstance(sample, dict) for violation in sample.get('textOverflows', [])]
    caption_samples = [sample for sample in telemetry if isinstance(sample, dict) and sample.get('captionVisible')]
    min_font = 48 if aspect == '9:16' else 40

    spoken_lines = [line for line in tl.get('lines', []) if line.get('segmentType') not in ('hook', 'outro', 'vote-cta')]
    planned_gaps = [next_line['startMs'] - line['endMs'] for line, next_line in zip(spoken_lines, spoken_lines[1:])]
    hook = next((line for line in tl.get('lines', []) if line.get('segmentType') == 'hook'), {})
    hook_words = hook.get('words') or []

    # Success criteria evaluations
    checks = {
        'hook_source_onset_scheduled_under_1_5s': bool(hook_words) and hook_words[0].get('startMs', 99999) < 1500,
        "no_static_over_1s_in_first_5s": freezes['maxFreezeFirst5sSec'] <= 1.05,
        "no_freeze_over_2s": freezes['maxFreezeOverallSec'] <= 2.05,
        **validate_caption_schedule(tl),
        **validate_export(probe, aspect, tl),
        'encoded_packet_cadence_cfr': cadence.get('ok') is True,
        'layout_telemetry_available': layout_valid,
        'zero_safe_zone_violations': layout_valid and len(safe_violations) == 0,
        'zero_text_overflows': layout_valid and len(overflow_violations) == 0,
        'caption_font_readable': layout_valid and bool(caption_samples) and all(sample.get('captionFontSizePx', 0) >= min_font for sample in caption_samples),
        "empty_dark_space_under_15_pct": mean_dark_space_pct <= 15.0,
        'final_mp4_audio_measured': not ebur128.get('error'),
        "target_lufs_met": not ebur128.get('error') and abs(ebur128.get("integratedLufs", -99) - (-14.0)) <= 1.0,
        "true_peak_safe": not ebur128.get('error') and ebur128.get("truePeakDbtp", 99) <= -1.0,
        "final_mix_intelligibility_ge_95": whisper_res.get('ok') is True and not whisper_res.get('skipped') and isinstance(whisper_res.get('wordMatchPct'), (int, float)) and whisper_res['wordMatchPct'] >= 95.0,
    }

    all_passed = all(checks.values())

    report = {
        "ok": all_passed,
        "videoPath": video_path,
        'aspect': aspect,
        'videoSha256': hashlib.file_digest(open(video_path, 'rb'), 'sha256').hexdigest(),
        "totalSec": total_sec,
        "checks": checks,
        "metrics": {
            "maxVisualGapFirst5sSec": max_gap_5s,
            "maxVisualGapOverallSec": max_gap_overall,
            'freezeDetection': freezes,
            'visualCadenceEvidence': 'Freeze gates measure decoded frame differences. Scene-cut gaps are advisory and do not imply an image freeze.',
            "meanEmptyDarkSpacePct": mean_dark_space_pct,
            "ebur128": ebur128,
            "silenceGapsCount": len(silences),
            "whisperIntelligibility": whisper_res,
            "alignmentDrift": alignment_drift,
            'alignmentEvidence': 'Planned frame schedule relative to forced-aligned source stems; not an independent final-mix acoustic measurement',
            'acousticAlignmentVerified': False,
            'audioMeasurementPath': video_path,
            'exportStreams': probe.get('streams', []),
            'encodedPacketCadence': cadence,
            'safeZoneViolations': safe_violations,
            'textOverflows': overflow_violations,
            'layoutTelemetryError': telemetry_error,
            'layoutSampleCount': len(telemetry),
            'plannedInterlineGapsMs': planned_gaps,
            'advisories': {'encodedSceneCutGapUnder2s': max_gap_overall <= 2.05, 'encodedSceneCutGapFirst5sUnder1s': max_gap_5s <= 1.05, 'loudnessRangeAbove4Lu': ebur128.get('loudnessRangeLu', 0) > 4, 'sourceInterlineGapsAtLeast250ms': bool(planned_gaps) and min(planned_gaps) >= 250},
            "laggingWordCount": len(lagging_words),
            "excessLeadWordCount": len(excess_lead_words),
            "avoidableFunctionWordPagesCount": len(function_word_violations),
            "totalCaptionPages": len(caption_pages),
        },
        "contactSheets": {
            "intro": sheet_intro,
            "punchlines": sheet_punch,
            "transitions": sheet_trans,
            "ending": sheet_ending,
        },
    }

    report_json_path = out_dir / "sensor-report.json"
    report_json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    sys.stdout.write(json.dumps(report) + "\n")


if __name__ == "__main__":
    main()

