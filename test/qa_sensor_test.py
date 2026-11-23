import importlib.util
from pathlib import Path
import sys
import unittest
import tempfile
import subprocess
from unittest.mock import patch
from subprocess import CompletedProcess

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import qa_review_sensor as sensor


class ExportValidationTests(unittest.TestCase):
    def fixture(self):
        return {'streams': [
            {'codec_type': 'video', 'codec_name': 'h264', 'width': 1080, 'height': 1920, 'avg_frame_rate': '60/1', 'r_frame_rate': '60/1', 'nb_frames': '600', 'duration': '10'},
            {'codec_type': 'audio', 'codec_name': 'aac', 'sample_rate': '48000', 'channels': 2, 'duration': '10'},
        ], 'format': {'duration': '10'}}

    def test_valid_native_sixty_export_passes(self):
        self.assertTrue(all(sensor.validate_export(self.fixture(), '9:16', {'fps': 60, 'totalDurationMs': 10000, 'totalFrames': 600}).values()))

    def test_absent_audio_and_wrong_duration_fail(self):
        data = self.fixture()
        data['streams'].pop()
        checks = sensor.validate_export(data, '9:16', {'fps': 60, 'totalDurationMs': 20000, 'totalFrames': 1200})
        self.assertFalse(checks['audio_48khz_stereo_aac'])
        self.assertFalse(checks['duration_matches_timeline'])

    def test_empty_or_estimated_alignment_cannot_pass(self):
        self.assertFalse(sensor.validate_caption_schedule({'lines': [], 'words': [], 'captionPages': []})['forced_source_alignment_present'])
        tl = {'lines': [{'alignmentSource': 'estimated', 'words': [{'text': 'hello'}]}], 'words': [{'text': 'hello', 'leadFrames': 1}], 'captionPages': [{'words': [{'text': 'hello'}]}]}
        self.assertFalse(sensor.validate_caption_schedule(tl)['forced_source_alignment_present'])

    def test_short_timeline_is_selected_by_aspect(self):
        self.assertEqual(sensor.select_timeline({'timelineV2': {'id': 'wide'}, 'shortsTimelineV2': {'id': 'short'}}, '9:16')['id'], 'short')

    def test_vfr_timestamps_fail_even_when_metadata_average_is_sixty(self):
        self.assertTrue(sensor.validate_packet_cadence([index / 60 for index in range(600)], 60, 600)['ok'])
        frames = [index / 60 for index in range(600)]
        frames[300] += .004
        self.assertFalse(sensor.validate_packet_cadence(frames, 60, 600)['ok'])

    def test_planned_events_do_not_hide_an_encoded_static_hold(self):
        with patch.object(sensor.subprocess, 'run', return_value=CompletedProcess([], 0, stdout='', stderr='')):
            first, overall, _ = sensor.measure_visual_change_intervals('static.mp4', 8, extra_event_times=[.5, 1, 2, 3, 4, 5, 6, 7])
        self.assertEqual(first, 5)
        self.assertEqual(overall, 8)

    def test_missing_audio_measurement_cannot_get_default_pass_values(self):
        with patch.object(sensor.subprocess, 'run', return_value=CompletedProcess([], 0, stdout='', stderr='')):
            result = sensor.measure_ebur128('silent.mp4')
        self.assertIn('error', result)

    def test_true_static_video_fails_freeze_gate_while_continuous_motion_passes(self):
        with tempfile.TemporaryDirectory(prefix='botbrawl-freeze-test-') as directory:
            for name, source, expected in [('static', 'color=c=navy:s=160x90:r=60', False), ('moving', 'testsrc2=s=160x90:r=60', True)]:
                path = str(Path(directory) / (name + '.mp4'))
                subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], check=True, timeout=20)
                result = sensor.measure_freeze_intervals(path, 3)
                self.assertEqual(result['maxFreezeFirst5sSec'] <= 1.05, expected, name)
                self.assertEqual(result['maxFreezeOverallSec'] <= 2.05, expected, name)

    def test_open_freeze_at_end_is_measured_to_media_duration(self):
        with patch.object(sensor.subprocess, 'run', return_value=CompletedProcess([], 0, stdout='', stderr='lavfi.freezedetect.freeze_start: 4.5')):
            result = sensor.measure_freeze_intervals('frozen-ending.mp4', 8)
        self.assertEqual(result['maxFreezeFirst5sSec'], .5)
        self.assertEqual(result['maxFreezeOverallSec'], 3.5)


if __name__ == '__main__':
    unittest.main()
