import { hasBinary, runCli } from './cli.js';

export default {
  id: 'claude',
  name: 'Claude Code',
  color: '#ff8a3d',
  available: () => hasBinary('claude'),
  // Aliases accepted by `claude --model`. Empty id = whatever Claude Code defaults to.
  models: () => [
    { id: '', name: 'Default' },
    { id: 'opus', name: 'Opus' },
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'haiku', name: 'Haiku' },
  ],
  // Tools disabled: pure text generation, streamed from stdout.
  async *generate({ prompt, signal, model }) {
    const m = model || process.env.CLAUDE_MODEL;
    yield* runCli({ bin: 'claude', args: ['-p', '--tools', '', ...(m ? ['--model', m] : [])], stdin: prompt, signal });
  },
};
