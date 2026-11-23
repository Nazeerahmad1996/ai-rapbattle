# BotBrawl production quality upgrade

This review starts from the two delivered `bad08f04` MP4s, not from the earlier plan's claims. Originals are preserved under `qa/production-upgrade/before/`. The previous automatic approval missed a real defect: encoded AAC peaked at +0.1 dBTP even though the PCM master measured -1.1 dBTP. Other confirmed weaknesses included a truncated spoken hook, aspect-mismatched timelines, repeated score increments for multi-sentence judgments, discontinuous camera retargets, and remote-font dependence.

## Delivery decisions and research

YouTube's [official upload guidance](https://support.google.com/youtube/answer/1722171?hl=en) supports native 60 fps, progressive H.264 High Profile, BT.709, 4:2:0, 48 kHz stereo and 384 kb/s audio. Production frames now originate as lossless PNG rather than a JPEG generation before H.264; CRF 17 prioritizes crisp artwork/text. The same frame rate drives timeline, motion, and encoded output. Audio is padded to the last complete frame rather than shortening the picture with `-shortest`.

[FFmpeg's filter documentation](https://ffmpeg.org/ffmpeg-filters.html) informs oversampled limiting and compensated lookahead latency. The mixer measures an AAC preview, then the reviewer measures the final MP4 independently. -14 LUFS is this project's target, not a claim that YouTube mandates that exact loudness. Loudness range is reported rather than forcing a short spoken video to exceed an arbitrary range.

[Kokoro's upstream voice notes](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) explain voice-quality differences and short-utterance limitations. Voice casting, clause pauses and compression differ by mode. Rap bars receive bounded duration fitting and start on the beat grid; future rap prompts ask for short performable bars rather than long prose. This is rhythmic spoken TTS, not a model trained to deliver sung rap. EQ and time stretching cannot manufacture a human musical performance.

## Motion and editorial behavior

- Shorts uses its own timeline for picture, captions, sound, and review.
- Complete hook phrases play without mid-word or mid-sentence time caps.
- Camera changes preserve the current position and velocity; hero handoffs dissolve without jumping between card positions.
- Beat motion is continuous; time-based impacts retain their duration at 30 or 60 fps.
- Poetry/story use calmer movement. Judges are identified as judges rather than showing one contestant speaking their judgment.
- Captions stay pinned, keep stable geometry, and are checked for overflow with actual bundled fonts.
- The ending uses a short audience question and a concise verdict. Scores update once per judged round.
- Exported videos are replaced only after encoding succeeds. Missing sound, assets or a production timeline fail rather than silently producing an incomplete video.

## Automatic review contract

Both requested aspects must pass. Checks include resolution, codec, exact frame count, packet timing, duration, stereo sample rate, encoded loudness/true peak, true frozen-frame intervals, caption schedule/source alignment, measured layout and final-mix transcription. Scene-cut spacing is an editorial advisory: continuous smooth motion does not need a hard cut every two seconds. Missing measurements and `--skip-whisper` cannot approve publication. `--force` regenerates content; it does not bypass a failed upload gate.

Repair is bounded to four reviews. Known loudness/music-masking failures can remix existing aligned stems and rerender. Layout defects and unknown failures stop for a concrete fix rather than running repeated identical jobs. The best candidate includes matching media, manifest, telemetry, and reports; it is restored as a set.

The automation HTTP response keeps its existing fields and adds `quality`, containing the review result, and `files.reviewJson` when rendering. `ok: true` means production returned files; consumers must inspect `quality.approvedForUpload` for the delivery decision. With `renderVideo: false`, `quality` is null. A failed studio build returns the existing `AUTOMATION_ERROR` envelope instead of silently falling back to an incompatible timeline.

## Evidence and limits

The audio-only controlled comparison is in `qa/production-upgrade/audio-audit.md`. Ten actual voice stems and five paired genre samples are in `qa/production-upgrade/voice-samples/`. Source alignment is measured against the synthesized stems. Planned highlight lead is not independent proof of millisecond-perfect alignment in the final mix. ASR agreement is a useful intelligibility check, not a substitute for a listener's assessment of delivery or comedy.

Sol 6.1 high reviewers independently examined motion, audio and production QA. Their regression tests cover interrupted motion, seeking, distinct aspect timelines, limiter latency, float-bus clipping, missing evidence, multi-aspect approval and best-candidate restoration. No video was uploaded as part of this work.

The closing spoken labels use violet/lime corners to avoid ambiguous isolated letters. Captions retain the actual spoken words. Publishable chapters are rebuilt from the final timeline and omitted when fewer than three valid ten-second chapters exist, following [YouTube’s chapter guidance](https://support.google.com/youtube/answer/9884579?hl=en).

## Final delivered result — verified 2026-11-02

Both `data/videos/bad08f04/battle-16x9.mp4` and `battle-9x16-shorts.mp4` independently passed all 22 export checks and the Sol 6.1 high review of encoded contact sheets/full-resolution frames. Each is 56.567 seconds, 3,394 frames at 60 fps, H.264 BT.709, with 48 kHz stereo AAC. Final encoded loudness is -14.2 LUFS and true peak is -2.4 dBTP. Script/transcription word agreement is 99.35%; there are no measured safe-zone violations or text overflows. The final delivery report is `data/videos/bad08f04/review.json`; the comparison summary is `qa/production-upgrade/summary.json`.

The first complete output audit failed on tight title line boxes and ambiguous spoken contestant letters. The line boxes were expanded and announcements changed to the visible violet/lime corner identities; the original performer verses were retained. Hard-cut cadence was separated from actual freeze detection, with generated static and continuously moving videos verifying that distinction. A subsequent encoded-output review passed in both formats. Historical failed reports remain under `qa/bad08f04/`.

Final regression evidence: 57 JavaScript tests including the real Chrome integration passed without skips; 14 Python tests passed. A read-only local capabilities check passed after restarting the app. A no-upload CLI check confirmed Shorts-only file selection and valid file statistics. Final approval was assembled from the independently measured reports only after verifying each delivered MP4's SHA-256 and its exact reference script. No further video encoding or source audio changes occurred after those audits.

### Fallback model attribution

Automated production commits a model identity only after a complete, nonempty response. Failed partial responses are discarded, cancellation never triggers another provider, and the successful replacement remains active for later turns. Saved fighters and judges now reflect successful contributors; a mid-battle replacement credits both models instead of rewriting earlier authorship. Round results and `verse-end` events include an additive `performers`/`performer` identity (provider id, model, name, stageName, color); render stems use the corresponding round's speaker. Existing event logs without this field remain readable. Previously rendered videos cannot be reliably relabeled without evidence of which model generated them.

Verified with simulated quota exhaustion, partial-output failure, mid-battle replacement, and cancellation tests. Full JavaScript suite: 59 passed, 1 opt-in browser test skipped. No live provider quota was consumed for this verification.
