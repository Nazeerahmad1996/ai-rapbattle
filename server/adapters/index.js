import { readFileSync, existsSync } from 'node:fs';
import { hasBinary, runCli } from './cli.js';
import claude from './claude.js';
import codex from './codex.js';
import antigravity from './antigravity.js';
import kimi from './kimi.js';

// Custom CLIs: add entries to custom-adapters.json, e.g.
// [{ "id": "custom", "name": "Custom CLI", "bin": "my-cli", "args": ["-p"], "color": "#b388ff" }]
// The prompt is sent on stdin; stdout is the verse.
function loadCustom() {
  const path = new URL('../../custom-adapters.json', import.meta.url);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')).map(c => ({
    id: c.id, name: c.name, color: c.color ?? '#b388ff',
    available: () => hasBinary(c.bin),
    models: () => [{ id: '', name: 'Default' }],
    async *generate({ prompt, signal }) {
      yield* runCli({ bin: c.bin, args: c.args ?? [], stdin: prompt, signal });
    },
  }));
}

// Kimi is disabled by default; set ENABLE_KIMI=1 in .env once authenticated via `kimi login`
export function getAdapters() {
  const base = [claude, codex, antigravity];
  if (process.env.ENABLE_KIMI === '1' || process.env.ENABLE_KIMI === 'true') {
    base.push(kimi);
  }
  return [...base, ...loadCustom()];
}
export function getAdapter(id, adapters = getAdapters()) {
  const a = adapters.find(x => x.id === id);
  if (!a) throw new Error(`Unknown adapter: ${id}`);
  return a;
}

/** A fighter/judge = adapter + chosen model. The label distinguishes mirror matches. */
export function bindModel(adapter, modelId = '') {
  const model = adapter.models().find(m => m.id === modelId);
  if (modelId && !model) throw new Error(`Unknown model "${modelId}" for ${adapter.name}`);
  const label = modelId ? `${adapter.name} (${model.name})` : adapter.name;
  return {
    id: adapter.id, model: modelId, name: label, color: adapter.color,
    available: () => adapter.available(),
    generate: args => adapter.generate({ ...args, model: modelId }),
  };
}
