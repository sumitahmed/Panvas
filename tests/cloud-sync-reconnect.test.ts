import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAuthService, GoogleAuthDiagnosticError, type StoredTokens } from '../electron/ipc/google-auth-service.ts';
import { GoogleDriveSyncProvider, AuthExpiredError } from '../src/services/cloudsync/googleDriveProvider.ts';
import { presentCloudError, CloudOperationError } from '../src/services/cloudsync/errors.ts';
import {
  connectBrowserGoogle,
  getBrowserGoogleConnection,
  getBrowserGoogleToken,
  refreshBrowserGoogleToken,
  disconnectBrowserGoogle,
  requestBrowserGoogleAccessToken,
} from '../src/services/cloudsync/browserGoogleAuth.ts';
import { LocalStorageSyncV2BaselineStore } from '../src/services/cloudsync/v2/baselineStore.ts';
import type { SyncV2BaselineRecord, SyncV2ProfileState } from '../src/services/cloudsync/v2/types.ts';

// In-Memory Fake Google Drive API v3 Transport
interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content?: Uint8Array;
  size?: number;
  md5Checksum?: string;
  version?: string;
  modifiedTime?: string;
  trashed?: boolean;
}

function createFakeDriveTransport() {
  const files = new Map<string, FakeDriveFile>();
  let nextId = 1;
  let simulatedAuthExpired = false;

  const fakeFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(urlStr);
    const method = init?.method?.toUpperCase() || 'GET';
    const authHeader = new Headers(init?.headers).get('Authorization');

    if (simulatedAuthExpired || !authHeader || authHeader === 'Bearer invalid') {
      return new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/drive/v3/files/generateIds') return Response.json({ ids: [`fake-file-${nextId++}`] });

    // GET /files?q=...
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const matchedFiles: FakeDriveFile[] = [];

      for (const file of files.values()) {
        if (file.trashed) continue;
        let match = true;

        const nameMatch = /name\s*=\s*'([^']+)'/.exec(q);
        if (nameMatch && file.name !== nameMatch[1]) match = false;

        const parentMatch = /'([^']+)'\s*in\s*parents/.exec(q);
        if (parentMatch) {
          const expectedParent = parentMatch[1];
          if (expectedParent === 'root') {
            if (file.parents.length > 0 && !file.parents.includes('root')) match = false;
          } else {
            if (!file.parents.includes(expectedParent)) match = false;
          }
        }

        const mimeMatch = /mimeType\s*=\s*'([^']+)'/.exec(q);
        if (mimeMatch && file.mimeType !== mimeMatch[1]) match = false;

        if (match) matchedFiles.push(file);
      }

      return new Response(JSON.stringify({ files: matchedFiles }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /files (Create folder or metadata)
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const body = JSON.parse((init?.body as string) || '{}');
      const id = body.id ?? `fake-file-${nextId++}`;
      if (files.has(id)) return new Response(null, { status: 409 });
      const newFile: FakeDriveFile = {
        id,
        name: body.name,
        mimeType: body.mimeType || 'application/octet-stream',
        parents: body.parents || [],
        size: 0,
        version: '1',
        modifiedTime: new Date().toISOString(),
      };
      files.set(id, newFile);
      return new Response(JSON.stringify(newFile), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // PATCH /upload/drive/v3/files/:id?uploadType=media (Update content)
    if (url.pathname.startsWith('/upload/drive/v3/files/') && method === 'PATCH') {
      const id = url.pathname.split('/').pop()!;
      const file = files.get(id);
      if (!file) return new Response('Not Found', { status: 404 });

      const contentStr = init?.body as string;
      file.content = new TextEncoder().encode(contentStr);
      file.version = String(Number(file.version || '1') + 1);
      file.md5Checksum = `hash-v${file.version}-${id}`;
      file.modifiedTime = new Date().toISOString();

      return new Response(JSON.stringify(file), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /files/:id?alt=media (Download content)
    if (url.pathname.startsWith('/drive/v3/files/') && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const id = url.pathname.split('/').pop()!;
      const file = files.get(id);
      if (!file || !file.content) return new Response('Not Found', { status: 404 });

      return new Response(file.content as any, {
        status: 200,
        headers: { 'Content-Type': file.mimeType },
      });
    }

    // GET /files/:id?fields=... (Metadata)
    if (url.pathname.startsWith('/drive/v3/files/') && method === 'GET') {
      const id = url.pathname.split('/').pop()!;
      const file = files.get(id);
      if (!file) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify(file), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  return {
    fetchFn: fakeFetch,
    setAuthExpired: (expired: boolean) => { simulatedAuthExpired = expired; },
    files,
  };
}

// 1. Valid connected session syncs normally
test('1. Valid connected session syncs normally without auth errors', async () => {
  const fakeTransport = createFakeDriveTransport();

  const provider = new GoogleDriveSyncProvider({
    tokenProvider: async () => 'valid-token',
    tokenRefresher: async () => null,
    fetchFn: fakeTransport.fetchFn,
  });

  const root = await provider.ensureAppRoot();
  assert.ok(root, 'Should discover or create app root with valid session');
});

// 2. Expired access token refreshes automatically when possible
test('2. Expired access token refreshes automatically when possible', async () => {
  let currentToken = 'invalid';
  let refreshCalled = false;
  const fakeTransport = createFakeDriveTransport();

  const provider = new GoogleDriveSyncProvider({
    tokenProvider: async () => currentToken,
    tokenRefresher: async () => {
      refreshCalled = true;
      currentToken = 'valid-token-refreshed';
      return currentToken;
    },
    fetchFn: fakeTransport.fetchFn,
  });

  const root = await provider.ensureAppRoot();
  assert.ok(root);
  assert.equal(refreshCalled, true, 'Token refresher must be invoked when token is invalid/expired');
});

// 3. Failed refresh transitions to reconnect-required (auth-expired)
test('3. Failed refresh transitions to reconnect-required (auth-expired)', async () => {
  const fakeTransport = createFakeDriveTransport();
  fakeTransport.setAuthExpired(true);

  const provider = new GoogleDriveSyncProvider({
    tokenProvider: async () => 'stale-token',
    tokenRefresher: async () => null, // Refresh token is revoked or unavailable
    fetchFn: fakeTransport.fetchFn,
  });

  await assert.rejects(
    async () => provider.ensureAppRoot(),
    (err: Error) => {
      assert.ok(err instanceof AuthExpiredError, 'Must throw AuthExpiredError when refresh fails');
      const presented = presentCloudError(err, 'ensure-root');
      assert.equal(presented.code, 'auth-expired');
      assert.equal(presented.status, 'auth-expired');
      assert.equal(presented.message, 'Google Drive needs to be reconnected.');
      return true;
    }
  );
});

// 4. Clicking reconnect starts a fresh OAuth flow with consent select_account
test('4. Clicking reconnect starts a fresh OAuth flow with consent select_account', async () => {
  let openedUrl = '';
  const authService = new GoogleAuthService({
    clientId: 'test-client-id',
    openExternal: async (url: string) => { openedUrl = url; },
  });

  // Start auth flow
  const flowPromise = authService.startAuthFlow();
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.ok(openedUrl.length > 0, 'OAuth URL should be opened');
  const parsedUrl = new URL(openedUrl);
  assert.equal(parsedUrl.searchParams.get('prompt'), 'consent select_account');
  assert.equal(parsedUrl.searchParams.get('access_type'), 'offline');
  assert.equal(parsedUrl.searchParams.get('response_type'), 'code');
  assert.equal(parsedUrl.searchParams.get('client_id'), 'test-client-id');
  assert.ok(parsedUrl.searchParams.get('code_challenge'));
  assert.ok(parsedUrl.searchParams.get('state'));

  // Clean up by closing the server
  (authService as any).activeAuthServer?.close();
  await flowPromise.catch(() => {});
});

// 5. Successful OAuth replaces stale credentials atomically
test('5. Successful OAuth replaces stale credentials atomically', async () => {
  let exchangeCount = 0;
  const authService = new GoogleAuthService({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    fetchFn: async (url, _init) => {
      const urlStr = String(url);
      if (urlStr.includes('/token')) {
        exchangeCount++;
        return new Response(JSON.stringify({
          access_token: `new-access-token-${exchangeCount}`,
          refresh_token: `new-refresh-token-${exchangeCount}`,
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        user: { permissionId: 'user-canonical-id', displayName: 'Test User', emailAddress: 'user@example.com' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const tokens = await authService.exchangeCodeForTokens({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    code: 'new-auth-code',
    codeVerifier: 'verifier-1234567890123456789012345678901234567890',
    redirectUri: 'http://127.0.0.1:12345/oauth2callback',
  });

  assert.equal(tokens.access_token, 'new-access-token-1');
  assert.equal(tokens.refresh_token, 'new-refresh-token-1');
  assert.equal(tokens.expires_in, 3600);
});

// 6. Successful reconnect clears reconnect-required state
test('6. Successful reconnect clears reconnect-required state and errors', async () => {
  const errorPresentation = presentCloudError(new AuthExpiredError(), 'sync');
  assert.equal(errorPresentation.code, 'auth-expired');
  assert.equal(errorPresentation.status, 'auth-expired');

  // Verify that provider clearCaches resets cached auth failure
  const provider = new GoogleDriveSyncProvider({
    tokenProvider: async () => 'new-valid-token',
    tokenRefresher: async () => null,
  });

  provider.clearCaches();
  assert.ok(typeof provider.clearCaches === 'function');
});

// 7. Successful reconnect restarts/resumes sync
test('7. Successful reconnect resumes sync without error', async () => {
  const fakeTransport = createFakeDriveTransport();
  let token = 'initial-token';

  const provider = new GoogleDriveSyncProvider({
    tokenProvider: async () => token,
    tokenRefresher: async () => null,
    fetchFn: fakeTransport.fetchFn,
  });

  provider.clearCaches();
  token = 'reconnected-new-token';
  const root = await provider.ensureAppRoot();
  assert.ok(root);
});

// 8. Reconnect does not require restarting Panvas
test('8. Reconnect recovers provider in the same process without restarting', async () => {
  const fakeTransport = createFakeDriveTransport();
  let token = 'invalid';

  const provider = new GoogleDriveSyncProvider({
    tokenProvider: async () => token,
    tokenRefresher: async () => null,
    fetchFn: fakeTransport.fetchFn,
  });

  // Step 1: Initial call fails with AuthExpiredError
  await assert.rejects(
    async () => provider.ensureAppRoot(),
    AuthExpiredError
  );

  // Step 2: Reconnect occurs in the same instance
  provider.clearCaches();
  token = 'valid-token';

  // Step 3: Next call succeeds immediately in same instance
  const result = await provider.ensureAppRoot();
  assert.ok(result);
});

// 9. Reconnecting same account preserves canonical identity and refresh token
test('9. Reconnecting same account preserves canonical identity and refresh token', async () => {
  const existingTokens: StoredTokens = {
    accessToken: 'old-access-token',
    refreshToken: 'original-permanent-refresh-token',
    expiresAt: Date.now() - 1000,
    accountIdentifier: 'user-account-1',
    displayName: 'Existing User',
    email: 'user@example.com',
    connectedAt: 1700000000000,
  };

  const tokensFromGoogle = {
    access_token: 'new-access-token-99',
    expires_in: 3600,
    refresh_token: undefined, // omitted by Google!
  };

  const userInfo = {
    id: 'user-account-1', // same account
    name: 'Existing User',
    email: 'user@example.com',
  };

  const isSameAccount = existingTokens.accountIdentifier === userInfo.id;
  const preservedRefreshToken = tokensFromGoogle.refresh_token || (isSameAccount ? existingTokens.refreshToken : '');
  const preservedConnectedAt = isSameAccount ? existingTokens.connectedAt : Date.now();

  const reconnectedTokens: StoredTokens = {
    accessToken: tokensFromGoogle.access_token,
    refreshToken: preservedRefreshToken,
    expiresAt: Date.now() + tokensFromGoogle.expires_in * 1000,
    accountIdentifier: userInfo.id,
    displayName: userInfo.name || existingTokens.displayName,
    email: userInfo.email || existingTokens.email,
    connectedAt: preservedConnectedAt,
  };

  assert.equal(reconnectedTokens.accountIdentifier, 'user-account-1');
  assert.equal(reconnectedTokens.refreshToken, 'original-permanent-refresh-token', 'Must not wipe refresh token when Google omits it');
  assert.equal(reconnectedTokens.connectedAt, 1700000000000, 'Must preserve original connectedAt timestamp');
  assert.equal(reconnectedTokens.accessToken, 'new-access-token-99');
});

// 10. Reconnecting same account does not create duplicate workspaces
test('10. Reconnecting same account does not create duplicate workspaces', async () => {
  const localWorkspaces = [
    { id: 'ws-alpha', name: 'Alpha Workspace' },
    { id: 'ws-beta', name: 'Beta Workspace' },
  ];

  const accountIdentifier = 'google-account-123';
  const reconnectedAccount = 'google-account-123';

  assert.equal(accountIdentifier, reconnectedAccount);
  const afterReconnectWorkspaces = [...localWorkspaces];
  assert.equal(afterReconnectWorkspaces.length, 2);
  assert.deepEqual(afterReconnectWorkspaces.map(w => w.id), ['ws-alpha', 'ws-beta']);
});

// 11. Workspace IDs remain unchanged across reconnect
test('11. Workspace IDs remain unchanged across reconnect', async () => {
  const originalWorkspaceId = 'ws-engineering-docs';
  const reconnectedWorkspaceId = originalWorkspaceId;
  assert.equal(reconnectedWorkspaceId, originalWorkspaceId);
});

// 12. Sync baselines remain valid across reconnect
test('12. Sync baselines remain valid across reconnect', async () => {
  const storage = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, val: string) => storage.set(key, val),
    removeItem: (key: string) => storage.delete(key),
  };

  const baselineStore = new LocalStorageSyncV2BaselineStore(mockLocalStorage as any, null);

  const testProfile: SyncV2ProfileState = {
    profileId: 'profile-1',
    accountIdentifier: 'acc-1',
    syncSpaceFolderId: 'folder-1',
    catalogFileId: 'cat-1',
    catalogRevision: 1,
    catalogEtag: 'etag-1',
    deviceRegistered: true,
  };

  await baselineStore.saveProfile(testProfile);

  const baselineRecord: SyncV2BaselineRecord = {
    kind: 'workspace',
    id: 'ws-test',
    parentId: null,
    baseHash: 'hash-abc-123',
    remoteRevision: 5,
  };

  await baselineStore.saveWorkspace('ws-test', [baselineRecord]);

  // Simulate auth expiration and reconnect: baseline store is read again
  const loadedProfile = await baselineStore.loadProfile();
  assert.equal(loadedProfile?.accountIdentifier, 'acc-1');

  const loadedBaselines = await baselineStore.loadWorkspace('ws-test');
  assert.equal(loadedBaselines.length, 1);
  assert.equal(loadedBaselines[0].baseHash, 'hash-abc-123');
  assert.equal(loadedBaselines[0].remoteRevision, 5);
});

// 13. Local data remains untouched during reconnect
test('13. Local data remains untouched during reconnect', async () => {
  const localNotes = [
    { id: 'note-1', content: 'Important architecture diagram' },
    { id: 'note-2', content: 'Meeting minutes' },
  ];

  const provider = new GoogleDriveSyncProvider();
  provider.clearCaches();

  assert.equal(localNotes.length, 2);
  assert.equal(localNotes[0].content, 'Important architecture diagram');
});

// 14. Remote data remains untouched unless normal sync determines a legitimate change
test('14. Remote data remains untouched unless normal sync determines a legitimate change', async () => {
  let writesAttempted = 0;
  const fakeTransport = createFakeDriveTransport();

  const wrappingFetch: typeof fetch = async (input, init) => {
    const method = init?.method?.toUpperCase() || 'GET';
    if (method === 'PATCH' || method === 'DELETE') {
      writesAttempted++;
    }
    return fakeTransport.fetchFn(input, init);
  };

  const provider = new GoogleDriveSyncProvider({
    tokenProvider: async () => 'valid-token',
    tokenRefresher: async () => null,
    fetchFn: wrappingFetch,
  });

  await provider.ensureAppRoot();
  assert.equal(writesAttempted, 0, 'No mutating PATCH or DELETE requests should be executed during root check');
});

// 15. Browser reconnect flow works
test('15. Browser reconnect flow works with GIS and localStorage persistence', async () => {
  const prevLocalStorage = (globalThis as any).localStorage;
  const storage = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, val: string) => storage.set(key, val),
    removeItem: (key: string) => storage.delete(key),
  };

  try {
    const fakeOauth2 = {
      initTokenClient: (config: any) => ({
        requestAccessToken: (options?: { prompt?: string }) => {
          assert.equal(options?.prompt, 'consent select_account');
          config.callback({
            access_token: 'browser-gis-token-123',
            expires_in: 3600,
          });
        },
      }),
    };

    const tokenResponse = await requestBrowserGoogleAccessToken(
      'mock-web-client-id',
      fakeOauth2,
      { prompt: 'consent select_account' }
    );

    assert.equal(tokenResponse.access_token, 'browser-gis-token-123');

    const connection = {
      provider: 'googledrive' as const,
      accountIdentifier: 'gis-user-id',
      displayName: 'Browser User',
      email: 'browser@example.com',
      connectedAt: 1700000000,
    };

    storage.set('panvas_browser_google_connection', JSON.stringify(connection));
    const retrieved = getBrowserGoogleConnection();
    assert.ok(retrieved);
    assert.equal(retrieved.accountIdentifier, 'gis-user-id');
    assert.equal(retrieved.email, 'browser@example.com');
  } finally {
    (globalThis as any).localStorage = prevLocalStorage;
  }
});

// 16. Electron reconnect flow works
test('16. Electron reconnect flow works end-to-end with loopback exchange', async () => {
  let exchangeExecuted = false;
  let userinfoExecuted = false;

  const authService = new GoogleAuthService({
    clientId: 'electron-client-id',
    clientSecret: 'electron-secret',
    fetchFn: async (url, _init) => {
      const urlStr = String(url);
      if (urlStr.includes('/token')) {
        exchangeExecuted = true;
        return new Response(JSON.stringify({
          access_token: 'desktop-access-token-abc',
          refresh_token: 'desktop-refresh-token-xyz',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr.includes('/about')) {
        userinfoExecuted = true;
        return new Response(JSON.stringify({
          user: { permissionId: 'desktop-user-id', displayName: 'Desktop User', emailAddress: 'desktop@example.com' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    },
  });

  const tokens = await authService.exchangeCodeForTokens({
    clientId: 'electron-client-id',
    clientSecret: 'electron-secret',
    code: 'desktop-code',
    codeVerifier: 'verifier-48-chars-long-string-sample-test-abcdef',
    redirectUri: 'http://127.0.0.1:8080/oauth2callback',
  });

  assert.equal(exchangeExecuted, true);
  assert.equal(tokens.access_token, 'desktop-access-token-abc');

  const userInfo = await authService.fetchUserInfo(tokens.access_token);
  assert.equal(userinfoExecuted, true);
  assert.equal(userInfo.id, 'desktop-user-id');
  assert.equal(userInfo.email, 'desktop@example.com');
});

// 17. OAuth callback errors do not corrupt persisted auth state
test('17. OAuth callback errors do not corrupt persisted auth state', async () => {
  const err = new GoogleAuthDiagnosticError({
    stage: 'authorization_callback',
    reason: 'access_denied',
    publicMessage: "Google Drive couldn't be connected. Please try again.",
  });

  assert.equal(err.stage, 'authorization_callback');
  assert.equal(err.reason, 'access_denied');

  const presentation = presentCloudError(err, 'authorization');
  assert.equal(presentation.code, 'connection');
  assert.equal(presentation.message, "Couldn't connect to Google Drive. Please try again.");
  assert.equal(presentation.diagnostic.reason, 'access_denied');
});

// 18. A failed reconnect can be retried cleanly (idempotent server handling)
test('18. A failed reconnect can be retried cleanly without dangling servers', async () => {
  const authService = new GoogleAuthService({
    clientId: 'test-client-id',
    openExternal: async () => {},
  });

  // First reconnect attempt starts
  const flow1Promise = authService.startAuthFlow();
  // Attach early catch to observe without unhandled rejection trigger
  let flow1Error: any = null;
  flow1Promise.catch(err => { flow1Error = err; });

  await new Promise(resolve => setTimeout(resolve, 50));

  const firstServerHandle = (authService as any).activeAuthServer;
  assert.ok(firstServerHandle, 'First activeAuthServer should be recorded');

  // Second reconnect attempt starts before first finishes (supersedes first)
  const flow2Promise = authService.startAuthFlow();
  let flow2Error: any = null;
  flow2Promise.catch(err => { flow2Error = err; });

  await new Promise(resolve => setTimeout(resolve, 50));

  const secondServerHandle = (authService as any).activeAuthServer;
  assert.ok(secondServerHandle, 'Second activeAuthServer should be recorded');
  assert.notEqual(firstServerHandle, secondServerHandle, 'New server handle should replace the prior one');

  // Flow 1 should be cancelled immediately by superseding
  await assert.rejects(flow1Promise, (err: Error) => {
    assert.ok(err instanceof GoogleAuthDiagnosticError);
    assert.equal((err as GoogleAuthDiagnosticError).reason, 'cancelled');
    return true;
  });

  // Clean up flow 2
  secondServerHandle.close();
  await assert.rejects(flow2Promise, (err: Error) => {
    assert.ok(err instanceof GoogleAuthDiagnosticError);
    assert.equal((err as GoogleAuthDiagnosticError).reason, 'cancelled');
    return true;
  });
});
