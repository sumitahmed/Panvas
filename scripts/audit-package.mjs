import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar'); // Installed by the existing electron-builder toolchain.
const directory = path.resolve(process.argv.find(arg => arg.startsWith('--dir='))?.slice(6) ?? 'release/win-unpacked');
const archive = path.join(directory, 'resources', 'app.asar');
const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
const forbidden = /(?:^|\/)(?:\.env(?:\.[^/]+)?|\.mcp\.json|\.git|tests|__tests__|fixtures|scratch|artifacts|strix_runs|agent|Panvas Knowledge Infrastructure)(?:\/|$)|\.(?:map|pfx|p12|pem|key|log)$/i;
const forbiddenFiles = files.filter(name => forbidden.test(name));
assert.deepEqual(forbiddenFiles, [], 'package must exclude local/private/development material');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(packaged.version, version);
const executable = await readFile(path.join(directory, 'Panvas.exe'));
assert.equal(executable.toString('ascii', 0, 2), 'MZ');
assert.equal(executable.readUInt16LE(executable.readUInt32LE(0x3c) + 4), 0x8664, 'Windows AMD64 executable');
// Compare confidential local values without printing any value. VITE_anon and
// OAuth public client IDs are public configuration, not credential assertions.
const sensitive = [];
// Google's installed-app OAuth credentials identify a public PKCE client. This
// explicit release option permits only those values in the native main bundle;
// renderer copies and every other confidential value remain audit failures.
const publicDesktopOauth = process.argv.includes('--public-desktop-oauth');
const desktopOauthKeys = new Set(['PANVAS_GOOGLE_CLIENT_SECRET', 'PANVAS_GOOGLE_SECRET']);
for (const [key, value] of Object.entries(process.env)) {
  if (/(?:SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE|ACCESS_TOKEN|REFRESH_TOKEN)/.test(key) && value && value.trim().length >= 12) sensitive.push({ key, value: value.trim() });
}
for (const file of ['.env', '.env.local']) {
  try {
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      const match = /^([A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE|ACCESS_TOKEN|REFRESH_TOKEN)[A-Z0-9_]*)\s*=\s*(.+)$/.exec(line);
      if (match) { const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2'); if (value.length >= 12) sensitive.push({ key: match[1], value }); }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
let secretMatches = 0;
let publicDesktopOauthMatches = 0;
for (const name of files.filter(name => /\.(?:m?js|cjs|json|html)$/.test(name))) {
  const normalized = path.normalize(name.replace(/^\//, ''));
  if ('files' in asar.statFile(archive, normalized)) continue; // e.g. the highlight.js directory
  const content = asar.extractFile(archive, normalized).toString();
  for (const { key, value } of sensitive) if (content.includes(value)) {
    if (publicDesktopOauth && desktopOauthKeys.has(key) && name.startsWith('/dist-electron/')) publicDesktopOauthMatches++;
    else secretMatches++;
  }
}
assert.equal(secretMatches, 0, 'confidential local configuration must not be embedded');
console.log(JSON.stringify({ version, architecture: 'x64', files: files.length, asarBytes: (await stat(archive)).size, forbiddenFiles: forbiddenFiles.length, confidentialMatches: secretMatches, publicDesktopOauthMatches }, null, 2));
