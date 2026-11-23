#!/usr/bin/env node
/**
 * Zero-dependency Model Context Protocol (MCP) stdio server for BotBrawl.
 * Allows Grokbot or any MCP-enabled agent to discover, health-check, and invoke BotBrawl tools natively.
 */
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCapabilities, runDoctorCheck } from '../server/automation.js';
import { getChromeExecutablePath } from '../server/video-renderer.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const DAILY_SCRIPT = join(ROOT_DIR, 'scripts', 'grokbot-daily.js');

const TOOLS = [
  {
    name: 'botbrawl_get_capabilities',
    description: 'List all available AI battle modes, 16 languages, installed AI CLI fighters/models, and CLI commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'botbrawl_doctor',
    description: 'Run a 2-second pre-flight healthcheck verifying FFmpeg, FFprobe, sidechain audio ducking, headless Chrome, Playwright video capture, AI CLI fighters, and YouTube OAuth env vars.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'botbrawl_produce_daily_video',
    description: 'Run an AI 1v1 battle (Rap, Roast, Debate, Poetry, Story), synthesize neural voices with word-level karaoke captions and backing beat, and render 16:9 Widescreen + 9:16 YouTube Shorts MP4s with VS Poster thumbnails.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'rap | roast | debate | poetry | story (optional; auto-rotates if omitted)' },
        language: { type: 'string', description: 'English | Urdu | Roman Urdu | Hindi | Hinglish | Spanish | etc.' },
        topic: { type: 'string', description: 'Custom battle topic (optional; auto-selects unplayed topic if omitted)' },
        rounds: { type: 'number', description: 'Number of rounds for 16:9 full episode (1 to 5, default 2)' },
        aModel: { type: 'string', description: 'Optional Corner A model ID (e.g. gemini-4-argon-high)' },
        bModel: { type: 'string', description: 'Optional Corner B model ID (e.g. claude-opus-5-5-high)' },
        shortsOnly: { type: 'boolean', description: 'Render only the 9:16 YouTube Shorts video' },
        widescreenOnly: { type: 'boolean', description: 'Render only the 16:9 Widescreen video' },
        noBeat: { type: 'boolean', description: 'Disable procedural backing beat & SFX' },
        force: { type: 'boolean', description: 'Force a fresh battle even if one was already generated today' },
        upload: { type: 'boolean', description: 'Upload rendered MP4s + VS Poster thumbnails to YouTube if YOUTUBE_* env vars are set' },
      },
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function runDailyScript(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [DAILY_SCRIPT, ...args], { cwd: ROOT_DIR, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async line => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'botbrawl-mcp', version: '1.1.0' },
        },
      });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const name = params?.name;
      const a = params?.arguments ?? {};
      if (name === 'botbrawl_get_capabilities') {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(getCapabilities(), null, 2) }] },
        });
      } else if (name === 'botbrawl_doctor') {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(runDoctorCheck(getChromeExecutablePath()), null, 2) }] },
        });
      } else if (name === 'botbrawl_produce_daily_video') {
        const cliArgs = [];
        if (a.mode) cliArgs.push('--mode', String(a.mode));
        if (a.language) cliArgs.push('--language', String(a.language));
        if (a.topic) cliArgs.push('--topic', String(a.topic));
        if (a.rounds) cliArgs.push('--rounds', String(a.rounds));
        if (a.aModel) cliArgs.push('--a-model', String(a.aModel));
        if (a.bModel) cliArgs.push('--b-model', String(a.bModel));
        if (a.shortsOnly) cliArgs.push('--shorts-only');
        if (a.widescreenOnly) cliArgs.push('--widescreen-only');
        if (a.noBeat) cliArgs.push('--no-beat');
        if (a.force) cliArgs.push('--force');
        if (a.upload) cliArgs.push('--upload');
        const out = await runDailyScript(cliArgs);
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: out }] },
        });
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    }
  } catch (e) {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
    }
  }
});
