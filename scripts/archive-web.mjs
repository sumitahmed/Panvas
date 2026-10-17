import { mkdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const dist = path.resolve(process.argv.find(arg => arg.startsWith('--dist='))?.slice(7) ?? 'dist');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await stat(path.join(dist, 'index.html'));
await mkdir(path.join(root, 'release'), { recursive: true });
const target = path.join(root, 'release', `Panvas-${version}-Web.zip`);
const result = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -Path (Join-Path $env:PANVAS_ARCHIVE_SOURCE "*") -DestinationPath $env:PANVAS_ARCHIVE_TARGET -Force'], {
      stdio: 'inherit', env: { ...process.env, PANVAS_ARCHIVE_SOURCE: dist, PANVAS_ARCHIVE_TARGET: target },
    })
  : spawnSync('zip', ['-qr', target, '.'], { cwd: dist, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Web archive failed (Windows PowerShell or Unix zip is required).');
console.log(target);
