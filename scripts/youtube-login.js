#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_ENV_PATH, loadDotEnv, upsertDotEnv } from '../server/automation.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');

/** Normalize a file path pasted or dragged from macOS Finder into Terminal. */
export function cleanMacPath(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1);
  } else {
    s = s.replace(/\\ /g, ' ');
  }
  if (s.startsWith('~/')) s = join(homedir(), s.slice(2));
  return s;
}

/** Parse Google Cloud Console OAuth JSON (`installed` Desktop app or `web` client format). */
export function parseGoogleClientJson(jsonOrString) {
  const parsed = typeof jsonOrString === 'string' ? JSON.parse(jsonOrString) : jsonOrString;
  const block = parsed?.installed || parsed?.web || parsed;
  const clientId = String(block?.client_id ?? '').trim();
  const clientSecret = String(block?.client_secret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('JSON file does not contain Google OAuth `client_id` and `client_secret` fields.');
  }
  return {
    clientId,
    clientSecret,
    clientType: parsed?.installed ? 'desktop' : parsed?.web ? 'web' : 'custom',
  };
}

/** Auto-discover the newest `client_secret*.json` in the project root or `~/Downloads`. */
export function discoverClientSecretFile(searchDirs = [ROOT_DIR, join(homedir(), 'Downloads')]) {
  const matches = [];
  for (const dir of searchDirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (/^client_secret.*\.json$/i.test(name)) {
          const full = join(dir, name);
          try {
            const st = statSync(full);
            if (st.isFile()) matches.push({ path: full, mtimeMs: st.mtimeMs });
          } catch { /* ignore unreadable */ }
        }
      }
    } catch { /* ignore unreadable dir */ }
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path || null;
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--client-id' && argv[i + 1]) opts.clientId = argv[++i].trim();
    else if (a === '--client-secret' && argv[i + 1]) opts.clientSecret = argv[++i].trim();
    else if ((a === '--credentials' || a === '--json') && argv[i + 1]) opts.credentialsPath = cleanMacPath(argv[++i]);
    else if (a === '--port' && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-') && a.endsWith('.json') && !opts.credentialsPath) {
      opts.credentialsPath = cleanMacPath(a);
    }
  }
  return opts;
}

async function resolveClientCredentials(opts) {
  loadDotEnv();

  if (opts.clientId && opts.clientSecret) {
    return { clientId: opts.clientId, clientSecret: opts.clientSecret, source: 'CLI flags' };
  }

  if (opts.credentialsPath) {
    const abs = resolve(opts.credentialsPath);
    if (!existsSync(abs)) throw new Error(`Credentials JSON file not found: ${abs}`);
    const creds = parseGoogleClientJson(readFileSync(abs, 'utf8'));
    return { ...creds, source: abs };
  }

  const discovered = discoverClientSecretFile();
  if (discovered) {
    const creds = parseGoogleClientJson(readFileSync(discovered, 'utf8'));
    return { ...creds, source: `${discovered} (auto-detected)` };
  }

  if (process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) {
    return {
      clientId: process.env.YOUTUBE_CLIENT_ID.trim(),
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET.trim(),
      source: DEFAULT_ENV_PATH,
    };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'No Google OAuth Client ID found. Download your Desktop OAuth JSON from Google Cloud Console into ~/Downloads (or pass --client-id and --client-secret) and re-run `npm run youtube-login`.',
    );
  }

  console.log('\n=== BotBrawl Official YouTube Login Setup ===');
  console.log('1. Open: https://console.cloud.google.com/apis/library/youtube.googleapis.com -> click Enable');
  console.log('2. Go to: Credentials -> Create Credentials -> OAuth client ID -> Desktop app');
  console.log('   (On OAuth Consent Screen -> Audience, add your Gmail under "Test users")');
  console.log('3. Either click "Download JSON" (or copy the Client ID & Client Secret).\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const first = (await rl.question('Paste your Client ID (or drag-and-drop the downloaded .json file here): ')).trim();
    const maybePath = cleanMacPath(first);
    if (maybePath.endsWith('.json') && existsSync(resolve(maybePath))) {
      const creds = parseGoogleClientJson(readFileSync(resolve(maybePath), 'utf8'));
      return { ...creds, source: resolve(maybePath) };
    }
    const autoAfterDownload = !first ? discoverClientSecretFile() : null;
    if (autoAfterDownload) {
      const creds = parseGoogleClientJson(readFileSync(autoAfterDownload, 'utf8'));
      return { ...creds, source: `${autoAfterDownload} (auto-detected)` };
    }
    const secret = (await rl.question('Paste your Client Secret: ')).trim();
    if (!first || !secret) {
      throw new Error('Both Client ID and Client Secret are required.');
    }
    return { clientId: first, clientSecret: secret, source: 'interactive prompt' };
  } finally {
    rl.close();
  }
}

function listenLoopback(server, preferredPort = 8919) {
  return new Promise((resolvePort, reject) => {
    const onError = err => {
      if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
        server.removeListener('error', onError);
        server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(preferredPort, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolvePort(server.address().port);
    });
  });
}

async function fetchConnectedChannel(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ch = data?.items?.[0];
    if (!ch) return { empty: true };
    return {
      id: ch.id,
      title: ch.snippet?.title || 'YouTube Channel',
      customUrl: ch.snippet?.customUrl || '',
    };
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        'Usage: npm run youtube-login [-- --credentials ~/Downloads/client_secret.json]',
        '       npm run youtube-login -- --client-id <ID> --client-secret <SECRET>',
        '',
        'Opens Google sign-in in your normal macOS browser (never blocked by automated-browser checks)',
        'and saves YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN to .env.',
      ].join('\n'),
    );
    return;
  }

  const { clientId, clientSecret, source } = await resolveClientCredentials(opts);
  console.log(`\n[youtube-login] Loaded OAuth client from: ${source}`);

  const state = randomBytes(16).toString('hex');
  let resolveAuthCode;
  let rejectAuthCode;
  const codePromise = new Promise((res, rej) => {
    resolveAuthCode = res;
    rejectAuthCode = rej;
  });

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== '/oauth2callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const errParam = reqUrl.searchParams.get('error');
    const returnedState = reqUrl.searchParams.get('state');
    const code = reqUrl.searchParams.get('code');

    if (errParam) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Google OAuth Error: ${escapeHtml(errParam)}</h2><p>You can close this tab and try again.</p>`);
      rejectAuthCode(new Error(`Google OAuth authorization declined or blocked: ${errParam}`));
      return;
    }
    if (!code || returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Invalid OAuth callback state.</h2><p>Please return to Terminal and run npm run youtube-login again.</p>');
      rejectAuthCode(new Error('Invalid OAuth callback state or missing authorization code.'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>BotBrawl YouTube Connected</title></head>
<body style="background:#0b0d14;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="background:#141824;border:1px solid #2a3147;border-radius:16px;padding:36px 44px;max-width:480px;text-align:center">
    <div style="font-size:42px;margin-bottom:12px">&#9989;</div>
    <h1 style="margin:0 0 10px;font-size:22px">YouTube Connected to BotBrawl!</h1>
    <p style="color:#94a3b8;line-height:1.5;margin:0">Your upload token is being saved to <code>.env</code> on your Mac. You can safely close this browser tab and return to Antigravity / Terminal.</p>
  </div>
</body>
</html>`);
    resolveAuthCode(code);
  });

  const port = await listenLoopback(server, opts.port || 8919);
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', YOUTUBE_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent select_account');
  authUrl.searchParams.set('state', state);

  console.log('\n[youtube-login] Opening Google sign-in in your normal macOS browser...');
  console.log(`If it does not open automatically, paste this URL into Safari or Chrome:\n\n  ${authUrl.toString()}\n`);

  if (!opts.noOpen && process.platform === 'darwin') {
    execFile('open', [authUrl.toString()], () => {});
  }

  let code;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  console.log('[youtube-login] Exchanging authorization code for refresh token...');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(`Failed to exchange OAuth code: ${JSON.stringify(tokenData)}`);
  }

  const refreshToken = tokenData.refresh_token || process.env.YOUTUBE_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      'Google did not return a refresh_token. Visit https://myaccount.google.com/permissions, remove temporary access for your app, and run `npm run youtube-login` once more.',
    );
  }

  upsertDotEnv({
    YOUTUBE_CLIENT_ID: clientId,
    YOUTUBE_CLIENT_SECRET: clientSecret,
    YOUTUBE_REFRESH_TOKEN: refreshToken,
  });

  const channel = await fetchConnectedChannel(tokenData.access_token);
  console.log(`\n[youtube-login] Saved YouTube credentials to ${DEFAULT_ENV_PATH}`);
  if (channel?.empty) {
    console.log(
      '[youtube-login] Warning: This Google account does not have a YouTube channel created yet. Open https://www.youtube.com once and click "Create channel" before uploading.',
    );
  } else if (channel?.title) {
    console.log(`[youtube-login] Connected YouTube Channel: "${channel.title}" ${channel.customUrl ? `(${channel.customUrl})` : `[${channel.id}]`}`);
  }
  console.log('[youtube-login] Test an immediate upload anytime with:');
  console.log('  npm run grokbot -- --force --upload\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(`\n[youtube-login] Error: ${err.message}\n`);
    process.exit(1);
  });
}

