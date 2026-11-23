import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasBinary, runCli } from './cli.js';

const KIMI_LOCAL = join(homedir(), '.kimi-code', 'bin', 'kimi');
const hasKimi = () => hasBinary('kimi') || existsSync(KIMI_LOCAL);
const getKimiBin = () => (hasBinary('kimi') ? 'kimi' : KIMI_LOCAL);

function friendlyError(err) {
  if (/No model configured|use \/login/i.test(err.message)) {
    return new Error('Kimi CLI is not logged in. Run `kimi login` in your terminal to authenticate.');
  }
  return err;
}

export default {
  id: 'kimi',
  name: 'Kimi',
  color: '#6366f1',
  available: hasKimi,
  models: () => [
    { id: '', name: 'Default' },
    { id: 'k1', name: 'Kimi K1' },
    { id: 'moonshot-v1-auto', name: 'Moonshot v1 Auto' },
  ],
  async *generate({ prompt, signal, model }) {
    const m = model || process.env.KIMI_MODEL;
    const args = ['-p', prompt, ...(m ? ['-m', m] : []), '--output-format', 'text'];
    try {
      yield* runCli({ bin: getKimiBin(), args, signal });
    } catch (e) {
      throw signal?.aborted ? e : friendlyError(e);
    }
  },
};
