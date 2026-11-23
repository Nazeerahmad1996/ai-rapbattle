---
name: botbrawl-daily-youtube
description: Automatically create daily AI Rap Battle, Roast Battle, Debate, Poetry Slam, or Story Duel videos (16:9 Widescreen + 9:16 YouTube Shorts) with neural voices, word-level karaoke captions, procedural backing beats, and VS Poster thumbnails.
---

# BotBrawl Daily YouTube Video Skill

When asked to create, edit, or upload a daily BotBrawl AI battle video for YouTube:

1. **Optional 2-second pre-flight healthcheck**:
   ```bash
   cd "/Users/mac/Desktop/untitled folder/Ai Rapbattle" && npm run grokbot -- --doctor
   ```
2. **Run the self-starting production command**:
   ```bash
   cd "/Users/mac/Desktop/untitled folder/Ai Rapbattle" && npm run grokbot -- --rounds 2 --force
   ```
   *(Optional flags: `--mode rap|roast|debate|poetry|story`, `--language Hinglish|Urdu|English|...`, `--shorts-only`, `--widescreen-only`, `--no-beat`, `--a-model <id>`, `--b-model <id>`.)*
3. **Parse the JSON response from `stdout`**:
   - `files.video16x9`: Full `1920x1080` MP4 broadcast episode for YouTube Main upload.
   - `files.video9x16Shorts`: Dedicated `1080x1920` MP4 highlight cut inside YouTube Shorts UI safe zones with live karaoke captions.
   - `files.thumbnail16x9` & `files.thumbnail9x16`: High-CTR VS Poster PNG thumbnails (no winner spoilers).
   - `youtube.title` & `youtube.shortsTitle`: Word-boundary smart-truncated titles guaranteed to retain `#Shorts`.
   - `youtube.description` & `youtube.tags`: Full description with `00:00` chapters, role breakdown, and deduplicated SEO tags.
4. **Upload to YouTube**:
   - Run `npm run youtube-login` once to sign into Google OAuth 2.0 in your normal macOS browser and automatically save `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REFRESH_TOKEN` to `.env`.
   - Pass `--upload` (`npm run grokbot -- --rounds 2 --upload` or `npm run grokbot -- --id <battleId> --upload`) to upload both MP4s and attach custom VS Poster thumbnails headlessly via YouTube Data API v3.
