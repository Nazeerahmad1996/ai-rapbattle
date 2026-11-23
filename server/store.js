import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync } from 'node:fs';

const DIR = new URL('../data/battles/', import.meta.url);
mkdirSync(DIR, { recursive: true });
const p = id => new URL(`${id}.json`, DIR);
const ID_RE = /^[a-f0-9-]{1,36}$/; // ids are generated server-side; reject anything else (path traversal)

// Write to a temp file then rename, so a crash can never leave a half-written battle file.
export function saveBattle(b) {
  if (!ID_RE.test(b.id)) throw new Error('invalid battle id');
  const tmp = p(`${b.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(b, null, 2));
  renameSync(tmp, p(b.id));
}

function readSafe(url) {
  try { return JSON.parse(readFileSync(url, 'utf8')); } catch { return null; } // skip corrupt files
}

export function loadBattle(id) {
  if (!ID_RE.test(id) || !existsSync(p(id))) return null;
  return readSafe(p(id));
}

export function listBattles() {
  return readdirSync(DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json'))
    .map(f => readSafe(new URL(f, DIR))).filter(Boolean)
    .sort((x, y) => y.createdAt - x.createdAt)
    .map(({ id, createdAt, config, fighters, status, totals, votes }) => ({ id, createdAt, config, fighters, status, totals, votes }));
}
