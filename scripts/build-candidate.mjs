import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';

// Run through npm so its own CLI path is portable across Windows/Linux.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Use npm run build:candidate.');
const env = { ...process.env };
for (const [key, value] of Object.entries(parse(await readFile('.env.example')))) {
  // Whitespace survives Windows environment propagation; consumers trim empty
  // credentials. It also prevents dotenv from filling them from a private .env.
  env[key] = value || ' ';
}
Object.assign(env, { VITE_ENABLE_CLOUD_SYNC: 'false', VITE_PANVAS_SYNC_V2: 'false', VITE_MARKETING_ONLY: 'false', VITE_ENABLE_ANALYTICS: 'false', CSC_IDENTITY_AUTO_DISCOVERY: 'false', PANVAS_GOOGLE_SECRET: ' ' });
delete env.ELECTRON_RUN_AS_NODE;
const run = args => {
  const result = spawnSync(process.execPath, [npm, ...args], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Candidate step failed: npm ${args.join(' ')}`);
};
if (!process.argv.includes('--web')) run(['run', 'package:win', '--', '--portable']);
if (!process.argv.includes('--desktop')) {
  run(['run', 'build:web', '--', '--outDir=artifacts/production-readiness-20261017/web-build']);
  const archive = spawnSync(process.execPath, ['scripts/archive-web.mjs', '--dist=artifacts/production-readiness-20261017/web-build'], { env, stdio: 'inherit' });
  if (archive.error) throw archive.error;
  if (archive.status !== 0) throw new Error('Candidate web archive failed.');
}
