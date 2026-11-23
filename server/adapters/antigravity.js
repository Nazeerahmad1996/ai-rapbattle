import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasBinary, runCli } from './cli.js';

const AGY_LOCAL = join(homedir(), '.local', 'bin', 'agy');
const hasAgy = () => hasBinary('agy') || existsSync(AGY_LOCAL);
const getAgyBin = () => (hasBinary('agy') ? 'agy' : AGY_LOCAL);

export default {
  id: 'antigravity',
  name: 'Antigravity',
  color: '#22c55e', // Antigravity emerald
  available: hasAgy,
  models: () => [
    { id: '', name: 'Default' },
    { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
    { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
    { id: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
    { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
    { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
    { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)' },
    { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
    { id: 'claude-sonnet-5-5-low', name: 'Claude Sonnet 5.5 (Low)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ],
  async *generate({ prompt, signal, model }) {
    const m = model || process.env.AGY_MODEL;
    const args = ['--dangerously-skip-permissions', ...(m ? ['--model', m] : []), '-p', prompt];
    yield* runCli({ bin: getAgyBin(), args, signal });
  },
};
