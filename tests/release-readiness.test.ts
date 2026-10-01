import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAudioOnlyMediaCheck, isAudioOnlyMediaRequest, isTrustedRendererUrl } from '../electron/security-policy.ts';

test('Electron renderer trust accepts only the configured app document/origin', () => {
  const renderer = path.resolve('dist');
  const fileUrl = pathToFileURL(path.join(renderer, 'index.html')).href;
  assert.equal(isTrustedRendererUrl(`${fileUrl}#/app`, undefined, renderer), true);
  assert.equal(isTrustedRendererUrl('file:///tmp/index.html#/app', undefined, renderer), false);
  assert.equal(isTrustedRendererUrl('https://localhost:3000/app', 'https://localhost:3000', renderer), true);
  assert.equal(isTrustedRendererUrl('https://evil.example/app', 'https://localhost:3000', renderer), false);
});

test('permission policy grants trusted main-frame audio and denies broader media', () => {
  assert.equal(isAudioOnlyMediaRequest('media', ['audio'], true), true);
  assert.equal(isAudioOnlyMediaRequest('media', ['audio', 'video'], true), false);
  assert.equal(isAudioOnlyMediaRequest('media', ['video'], true), false);
  assert.equal(isAudioOnlyMediaRequest('media', ['audio'], false), false);
  assert.equal(isAudioOnlyMediaRequest('geolocation', ['audio'], true), false);
  assert.equal(isAudioOnlyMediaCheck('media', 'audio', true), true);
  assert.equal(isAudioOnlyMediaCheck('media', 'video', true), false);
  assert.equal(isAudioOnlyMediaCheck('media', 'audio', false), false);
});

test('release manifest and CSP exclude sensitive or executable renderer capabilities', async () => {
  const [html, packageText, preload] = await Promise.all([
    readFile('index.html', 'utf8'),
    readFile('package.json', 'utf8'),
    readFile('electron/preload.ts', 'utf8'),
  ]);
  const manifest = JSON.parse(packageText);
  const files = JSON.stringify(manifest.build?.files ?? []);
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src https:\/\/accounts\.google\.com\/gsi\//);
  assert.doesNotMatch(html, /frame-src[^;]*\*/);
  assert.match(files, /!\*\*\/\.env/);
  assert.match(files, /!\*\*\/\.env\.\*/);
  assert.match(files, /!\*\*\/\.mcp\.json/);
  assert.match(files, /Panvas Knowledge Infrastructure/);
  assert.doesNotMatch(preload, new RegExp('nodeIntegration|child_process|execFile|spawn\\('));
  const knowledgeStart = preload.indexOf('knowledge:');
  const cloudSyncStart = preload.indexOf('cloudsync:', knowledgeStart);
  const knowledgeBlock = preload.slice(knowledgeStart, cloudSyncStart);
  for (const operation of ['search_knowledge', 'get_note_context', 'find_related', 'knowledge_health', 'get_note_ref']) {
    assert.match(knowledgeBlock, new RegExp(operation));
  }
  assert.doesNotMatch(knowledgeBlock, /write|delete|move|copy|open_file|credential|apiKey/i);
});

test('Windows release metadata preserves Panvas user data and excludes development material', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const build = manifest.build;
  const files = JSON.stringify(build?.files ?? []);
  const nsis = build?.nsis ?? {};
  const winTargets = build?.win?.target ?? [];

  assert.equal(manifest.name, 'panvas');
  assert.equal(manifest.version, '0.1.3');
  assert.equal(build?.appId, 'com.panvas.app');
  assert.equal(build?.productName, 'Panvas');
  assert.equal(build?.win?.artifactName, '${productName}-${version}-Setup.${ext}');
  assert.equal(build?.win?.icon, 'build/icon.ico');
  assert.ok(winTargets.some((target: { target?: string }) => target.target === 'nsis'));
  assert.equal(nsis.createDesktopShortcut, true);
  assert.equal(nsis.createStartMenuShortcut, true);
  assert.equal(nsis.deleteAppDataOnUninstall, false);
  assert.match(files, /!\*\*\/\.env/);
  assert.match(files, /!\*\*\/\.mcp\.json/);
  assert.match(files, /!\*\*\/(?:test|tests|__tests__)\/\*\*/);
  assert.match(files, /!\*\*\/(?:scratch|artifacts)\/\*\*/);
});

test('incomplete legacy cloud sync is quarantined and cannot delete local data on authorization failure', async () => {
  const [engine, env] = await Promise.all([
    readFile('src/services/sync/SyncEngine.ts', 'utf8'),
    readFile('.env.example', 'utf8'),
  ]);
  assert.match(env, /^VITE_ENABLE_CLOUD_SYNC=false$/m);
  assert.match(engine, /LEGACY_SYNC_QUARANTINED = true/);
  assert.match(engine, /local data preserved/i);
  assert.doesNotMatch(engine, /await db\.(workspaces|folders|canvasFiles)\.delete\(item\.entityId\)/);
  assert.doesNotMatch(engine, /supabase\.from\('[^']+'\)\.delete\(\)/);
});

test('public Windows download metadata and CTAs use the current release', async () => {
  const { PANVAS_RELEASE } = await import('../src/components/marketing/releaseMetadata.ts');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const windows = PANVAS_RELEASE.windows;
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(PANVAS_RELEASE.project.version, manifest.version);
  assert.equal(windows.version, manifest.version);
  assert.equal(windows.releaseTag, `v${manifest.version}`);
  assert.equal(windows.installerFileName, `Panvas-${manifest.version}-Setup.exe`);
  const releases = `${PANVAS_RELEASE.project.githubRepoUrl}/releases`;
  assert.equal(windows.downloadUrl, `${releases}/download/${windows.releaseTag}/${windows.installerFileName}`);
  assert.equal(windows.releaseNotesUrl, `${releases}/tag/${windows.releaseTag}`);
  assert.equal(windows.checksumUrl, `${releases}/download/${windows.releaseTag}/SHA256SUMS.txt`);
  for (const name of ['LandingPage', 'HeroInkPlayground', 'DownloadPage']) {
    const source = await readFile(`src/components/marketing/${name}.tsx`, 'utf8');
    assert.ok(source.includes('href={PANVAS_RELEASE.windows.downloadUrl}'), `${name} downloads the installer directly`);
    assert.doesNotMatch(source, /0\.1\.2/, `${name} contains no stale release label`);
  }
  const download = await readFile('src/components/marketing/DownloadPage.tsx', 'utf8');
  assert.match(download, /disabled=\{!PANVAS_INSTALLER_SHA256\}/);
  assert.match(download, /Published in SHA256SUMS\.txt/);
});

test('published Windows artifact metadata includes its hash, byte size and release notes', async () => {
  const { PANVAS_RELEASE } = await import('../src/components/marketing/releaseMetadata.ts');
  const windows = PANVAS_RELEASE.windows;
  assert.match(windows.checksumSha256, /^[0-9a-f]{64}$/);
  assert.match(windows.installerSize, /^[1-9][0-9,]* bytes$/);
  const bytes = Number(windows.installerSize.replaceAll(',', '').replace(' bytes', ''));
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
  assert.equal(windows.releaseDate, 'October 2026');
  const [download, readme] = await Promise.all([
    readFile('src/components/marketing/DownloadPage.tsx', 'utf8'),
    readFile('README.md', 'utf8'),
  ]);
  assert.ok(download.includes('href={PANVAS_RELEASE.windows.releaseNotesUrl}'));
  assert.ok(readme.includes(windows.downloadUrl));
  assert.ok(readme.includes(windows.checksumSha256));
});
