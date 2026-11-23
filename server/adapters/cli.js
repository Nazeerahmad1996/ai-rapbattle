import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_OUTPUT_CHARS = 50_000; // a verse is tiny; this bounds memory if a CLI misbehaves

export function hasBinary(bin) {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
}

/**
 * Run a command (no shell, so no injection), feeding `stdin`, yielding stdout chunks as they arrive.
 * Runs in an empty temp dir so agents can't wander into real projects.
 */
export async function* runCli({ bin, args, stdin, signal, timeoutMs = 120000, cwd }) {
  const child = spawn(bin, args, { cwd: cwd ?? tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], signal });
  let stderr = '';
  child.stderr.on('data', d => { if (stderr.length < 5000) stderr += d; });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.on('error', () => {});
  // A CLI that exits early closes stdin; without this handler the EPIPE would crash the server.
  child.stdin.on('error', () => {});
  if (stdin != null) child.stdin.write(stdin);
  child.stdin.end();

  const done = new Promise(res => child.on('close', res));
  try {
    let stdout = '';
    for await (const chunk of child.stdout) {
      const s = chunk.toString();
      stdout += s;
      if (stdout.length > MAX_OUTPUT_CHARS) throw new Error(`${bin} produced too much output`);
      yield s;
    }
    const code = await done;
    if (code !== 0) throw new Error(`${bin} exited with ${code}: ${(stderr || stdout).trim().slice(-300)}`);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

export function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'rap-'));
  const file = join(dir, 'out.txt');
  return { file, read: () => { try { return readFileSync(file, 'utf8'); } catch { return ''; } }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
