import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const release = path.join(root, 'release');
const stage = await mkdtemp(path.join(os.tmpdir(), 'panvas-release-'));
const directoryOnly = process.argv.includes('--dir');
const portable = process.argv.includes('--portable');

try {
  const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  // Publishing is an explicit, separate release step. electron-builder otherwise
  // infers a publisher in CI and can request credentials or upload on its own.
  const args = [cli, '--publish', 'never', '--win', ...(portable && !directoryOnly ? ['nsis', 'portable'] : []), '--x64', `--config.directories.output=${stage}`];
  if (portable) args.push('--config.portable.artifactName=${productName}-${version}-Portable.${ext}');
  if (directoryOnly) args.push('--dir');
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    await mkdir(release, { recursive: true });
    // The staged package is complete: merging an old unpacked directory can
    // otherwise retain obsolete DLLs/resources from a previous Electron build.
    {
      await rm(path.join(release, 'win-unpacked'), { recursive: true, force: true });
      await rm(path.join(release, 'win-unpacked.tmp'), { recursive: true, force: true });
    }
    for (const entry of await readdir(stage, { withFileTypes: true })) {
      await cp(path.join(stage, entry.name), path.join(release, entry.name), {
        recursive: entry.isDirectory(),
        force: true,
      });
    }
    console.log(`Windows ${directoryOnly ? 'directory' : 'installer'} artifacts copied to ${release}`);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
