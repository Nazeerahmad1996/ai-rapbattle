# AGENTS.md — BotBrawl Autonomous Agent & Grokbot Guide

This repository (`BotBrawl`) is an AI 1v1 Battle Arena & Automated Video Studio with built-in free Neural TTS (`msedge-tts`) and headless MP4 rendering (`16:9` Widescreen + `9:16` Vertical Shorts).

## 1. One-Command Daily Video Production (Recommended for Grokbot)

```bash
npm run grokbot
```

- **Self-Starting:** Automatically starts the local BotBrawl server on `127.0.0.1:3000` if it is not already running.
- **Zero-CLI Login Required by Grokbot:** Uses the host Mac's already-authenticated CLI adapters (`antigravity`, `claude`, `codex`, `kimi`) with automatic quota failover.
- **Daily Idempotency:** Running `npm run grokbot` multiple times on the same day returns the cached `daily-YYYY-MM-DD.json` result immediately. Pass `--force` to generate a brand-new battle.
- **Pure JSON Output on `stdout`:** Progress logs are written to `stderr`; `stdout` is strictly a single JSON envelope containing:
  - `files.video16x9` — Absolute path to `battle-16x9.mp4` (`1920x1080`, 60fps CFR, AAC 384kbps)
  - `files.video9x16Shorts` — Absolute path to `battle-9x16-shorts.mp4` (`1080x1920`, 60fps CFR, active-speaker spotlight)
  - `files.thumbnail16x9` — Absolute path to `thumbnail-16x9.png`
  - `files.thumbnail9x16` — Absolute path to `thumbnail-9x16.png`
  - `youtube.title`, `youtube.shortsTitle`, `youtube.description` (with `00:00` chapters), `youtube.tags`

## 2. Custom CLI Flags

```bash
# Run a 2-second pre-flight healthcheck (FFmpeg, Chrome, Playwright video helper, AI CLIs, YouTube env):
npm run grokbot -- --doctor

# Force a new battle with custom mode, language, or rounds:
npm run grokbot -- --mode roast --language Hinglish --rounds 2 --force

# Fast Shorts-only or Widescreen-only render (or disable the backing beat with --no-beat):
npm run grokbot -- --shorts-only --force
npm run grokbot -- --widescreen-only --no-beat --force

# Inspect all valid modes, languages, and installed fighter models as JSON:
npm run grokbot -- --capabilities

# One-time official YouTube OAuth 2.0 sign-in in your normal macOS browser (saves refresh token to .env):
npm run youtube-login

# Produce AND upload MP4s + custom VS Poster thumbnails directly to YouTube:
npm run grokbot -- --force --upload
```

## 3. HTTP Automation API (When Server Is Running on `http://127.0.0.1:3000`)

- `GET /llms.txt` — Concise plain-text capability overview.
- `GET /api/automation/capabilities` — Full JSON schema of modes, 16 languages, and available fighters.
- `POST /api/automation/produce` — Runs battle, synthesizes neural MP3 stems, renders `16:9` + `9:16` MP4s, and returns the JSON envelope.
  - Optional JSON body: `{ "mode": "rap", "language": "English", "topic": "...", "rounds": 2, "renderVideo": true, "aspects": ["16:9", "9:16"] }`
- `GET /api/automation/battles/:id/manifest` — Returns the millisecond-locked timeline and YouTube metadata for a produced battle.

## 4. MCP Server (Model Context Protocol)

To connect Grokbot via stdio MCP:
```bash
node "/Users/mac/Desktop/untitled folder/Ai Rapbattle/scripts/mcp-server.js"
```
Tools exposed:
- `botbrawl_get_capabilities`
- `botbrawl_doctor`
- `botbrawl_produce_daily_video`

