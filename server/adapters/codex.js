import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasBinary, runCli, tempFile } from './cli.js';

const CACHE_MS = 60_000;
let cached = { at: 0, models: null };

const toList = catalog => (catalog.models ?? [])
  .filter(m => m.visibility === 'list')
  .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  .map(m => ({ id: m.slug, name: m.display_name || m.slug }));

// Ask the CLI itself which models it offers: that's the catalog this exact binary and login will use.
// ~/.codex/models_cache.json is shared with the desktop app and changes between runs, so it is only a fallback.
function listModels() {
  if (cached.models && Date.now() - cached.at < CACHE_MS) return cached.models;
  let models = [];
  try {
    models = toList(JSON.parse(execFileSync('codex', ['debug', 'models'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })));
  } catch {
    try { models = toList(JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'))); } catch { /* none */ }
  }
  if (!models.length) models = [{ id: '', name: 'Default (from ~/.codex/config.toml)' }];
  cached = { at: Date.now(), models };
  return models;
}

// Turn Codex's raw JSON error into something actionable.
function friendlyError(err, model) {
  if (/model_not_found|model is not supported/i.test(err.message)) {
    const avail = listModels().map(m => m.id).filter(Boolean).join(', ');
    return new Error(`Codex doesn't allow the model "${model || 'from your config.toml'}" on your account. Pick another model${avail ? ` (available now: ${avail})` : ''}.`);
  }
  if (/usage limit/i.test(err.message)) return new Error('Codex usage limit reached. Wait for it to reset (see chatgpt.com/codex/settings/usage) or pick another platform.');
  return err;
}

export default {
  id: 'codex',
  name: 'Codex',
  color: '#3de0a8',
  available: () => hasBinary('codex'),
  models: listModels,
  // Codex stdout is noisy, so read the final message from a file instead.
  // The verse arrives as a single chunk when Codex finishes.
  async *generate({ prompt, signal, model }) {
    const out = tempFile();
    const m = model || process.env.CODEX_MODEL;
    try {
      for await (const _ of runCli({
        bin: 'codex',
        args: ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only',
          ...(m ? ['-m', m] : []), '-o', out.file, '-'],
        stdin: prompt, signal,
      })) { /* discard progress noise */ }
      const text = out.read().trim();
      if (!text) throw new Error('codex returned an empty response');
      yield text;
    } catch (e) {
      throw signal?.aborted ? e : friendlyError(e, m);
    } finally { out.cleanup(); }
  },
};
