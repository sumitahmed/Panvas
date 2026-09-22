import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { isTrustedIpcSender } from '../electron/security-policy.ts';

const CLOUDSYNC_CHANNELS = [
  'cloudsync:connect', 'cloudsync:disconnect', 'cloudsync:getConnection',
  'cloudsync:resetLocalData',
  'cloudsync:drive:ensureAppRoot', 'cloudsync:drive:listRemoteWorkspaces', 'cloudsync:drive:readManifest',
  'cloudsync:drive:writeManifest', 'cloudsync:drive:getObject', 'cloudsync:drive:putObjectIfAbsent',
  'cloudsync:drive:deleteObject', 'cloudsync:drive:moveObject', 'cloudsync:drive:getMetadata',
  'cloudsync:drive:findCandidatePanvasRoots', 'cloudsync:drive:readRootJson', 'cloudsync:drive:readWorkspaceJson',
  'cloudsync:drive:readCandidateRootJson', 'cloudsync:drive:readCandidateWorkspaceJson', 'cloudsync:drive:getCandidateObject',
  'cloudsync:driveV2:readRootJson', 'cloudsync:driveV2:writeRootJson', 'cloudsync:driveV2:readWorkspaceJson',
  'cloudsync:driveV2:writeWorkspaceJson', 'cloudsync:driveV2:getObject', 'cloudsync:driveV2:putObjectIfAbsent',
  'cloudsync:driveV2:getMetadata',
] as const;

function rendererEvent(url: string, parent: unknown = null) {
  return { senderFrame: { url, parent } };
}

async function electronModuleServer() {
  return createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } });
}

test('trusted IPC policy accepts only the top-level Panvas document', () => {
  const renderer = path.resolve('dist');
  const trustedFile = pathToFileURL(path.join(renderer, 'index.html')).href;
  assert.equal(isTrustedIpcSender(rendererEvent(trustedFile), undefined, renderer), true);
  assert.equal(isTrustedIpcSender(rendererEvent('https://panvas.test/app'), 'https://panvas.test', renderer), true);
  assert.equal(isTrustedIpcSender(rendererEvent('https://evil.test/app'), 'https://panvas.test', renderer), false);
  assert.equal(isTrustedIpcSender(rendererEvent('https://panvas.test/frame', {}), 'https://panvas.test', renderer), false);
  assert.equal(isTrustedIpcSender(rendererEvent('ftp://panvas.test/app'), 'https://panvas.test', renderer), false);
  assert.equal(isTrustedIpcSender({ senderFrame: null }, 'https://panvas.test', renderer), false);
  assert.equal(isTrustedIpcSender({}, 'https://panvas.test', renderer), false);
});

test('every privileged CloudSync invoke handler rejects before its operation runs', async () => {
  const server = await electronModuleServer();
  const trustedUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'index.html')).href;
  try {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const { registerCloudSyncHandlers } = await server.ssrLoadModule('/electron/ipc/cloudsync-handlers.ts');
    const { googleAuthService } = await server.ssrLoadModule('/electron/ipc/google-auth-service.ts');
    const originalGetConnectionInfo = googleAuthService.getConnectionInfo;
    let privilegedCalls = 0;
    googleAuthService.getConnectionInfo = async () => { privilegedCalls += 1; return null; };
    registerCloudSyncHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); } });
    assert.deepEqual([...handlers.keys()], [...CLOUDSYNC_CHANNELS]);

    for (const [channel, handler] of handlers) {
      assert.throws(() => handler(rendererEvent('https://evil.test'), 'googledrive'), {
        message: 'Untrusted IPC sender.',
      }, channel);
    }
    assert.equal(privilegedCalls, 0);
    assert.throws(() => handlers.get('cloudsync:getConnection')?.({}, 'googledrive'), { message: 'Untrusted IPC sender.' });
    assert.equal(privilegedCalls, 0);

    const getConnection = handlers.get('cloudsync:getConnection');
    assert.ok(getConnection);
    assert.equal(await getConnection(rendererEvent(trustedUrl), 'googledrive'), null);
    assert.equal(privilegedCalls, 1);
    googleAuthService.getConnectionInfo = originalGetConnectionInfo;
  } finally {
    await server.close();
  }
});

test('CloudSync diagnostic registration rejects untrusted senders before logging', async () => {
  const server = await electronModuleServer();
  const trustedUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'index.html')).href;
  const originalWarn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings += 1; };
  try {
    let listener: ((...args: unknown[]) => void) | undefined;
    const { registerCloudSyncDiagnosticHandler } = await server.ssrLoadModule('/electron/ipc/cloudsync-diagnostic-handler.ts');
    registerCloudSyncDiagnosticHandler({ on: (_channel: string, candidate: (...args: unknown[]) => void) => { listener = candidate; } });
    assert.ok(listener);
    assert.throws(() => listener?.(rendererEvent('https://evil.test'), { stage: 'authorization' }), { message: 'Untrusted IPC sender.' });
    assert.equal(warnings, 0);
    listener(rendererEvent(trustedUrl), { stage: 'authorization' });
    assert.equal(warnings, 1);
  } finally {
    console.warn = originalWarn;
    await server.close();
  }
});
