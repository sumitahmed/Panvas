import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fetchAccount, requestBrowserGoogleAccessToken } from '../src/services/cloudsync/browserGoogleAuth.ts';
import { CloudOperationError, sanitizeCloudDiagnostic } from '../src/services/cloudsync/errors.ts';

test('requestBrowserGoogleAccessToken captures and sanitizes Google Identity Services error details', async () => {
  const fakeClientId = '486992017517-uog6ucb24pkidgp5tcg1icuif4a3sprc.apps.googleusercontent.com';

  // 1. Success case
  let requestedOptions: any = null;
  const mockSuccessOauth2 = {
    initTokenClient: (config: any) => ({
      requestAccessToken: (options: any) => {
        requestedOptions = options;
        config.callback({
          access_token: 'fake-access-token-12345',
          expires_in: '3599',
          scope: config.scope,
          token_type: 'Bearer',
        });
      },
    }),
  };

  const successResponse = await requestBrowserGoogleAccessToken(fakeClientId, mockSuccessOauth2, { prompt: 'consent' });
  assert.equal(successResponse.access_token, 'fake-access-token-12345');
  assert.equal(requestedOptions?.prompt, 'consent');

  // 2. GIS callback returns error (e.g. access_denied, popup_closed_by_user)
  const mockDeniedOauth2 = {
    initTokenClient: (config: any) => ({
      requestAccessToken: () => {
        config.callback({
          error: 'access_denied',
          error_description: 'The user denied the request to authorize the application.',
          error_subtype: 'access_denied',
        });
      },
    }),
  };

  await assert.rejects(
    requestBrowserGoogleAccessToken(fakeClientId, mockDeniedOauth2),
    (err: any) => {
      assert.ok(err instanceof CloudOperationError);
      assert.equal(err.code, 'connection');
      assert.equal(err.diagnostic.stage, 'gis_token');
      assert.equal(err.diagnostic.reason, 'access_denied');
      assert.equal(err.diagnostic.retryable, false); // access_denied is not retryable
      return true;
    },
  );

  // 3. GIS error_callback (popup failed to open / popup closed)
  const mockPopupFailedOauth2 = {
    initTokenClient: (config: any) => ({
      requestAccessToken: () => {
        config.error_callback({
          type: 'popup_failed_to_open',
          message: 'The popup window could not be opened.',
        });
      },
    }),
  };

  await assert.rejects(
    requestBrowserGoogleAccessToken(fakeClientId, mockPopupFailedOauth2),
    (err: any) => {
      assert.ok(err instanceof CloudOperationError);
      assert.equal(err.code, 'connection');
      assert.equal(err.diagnostic.stage, 'gis_popup');
      assert.equal(err.diagnostic.reason, 'popup_failed_to_open');
      assert.equal(err.diagnostic.retryable, true);
      return true;
    },
  );

  // 4. Missing oauth2 object
  await assert.rejects(
    requestBrowserGoogleAccessToken(fakeClientId, null),
    (err: any) => {
      assert.ok(err instanceof CloudOperationError);
      assert.equal(err.diagnostic.stage, 'gis_load');
      assert.equal(err.diagnostic.reason, 'oauth2_unavailable');
      return true;
    },
  );

  // 5. Thrown exception during requestAccessToken
  const mockThrowsOauth2 = {
    initTokenClient: () => ({
      requestAccessToken: () => {
        throw new Error('BlockedByClient');
      },
    }),
  };

  await assert.rejects(
    requestBrowserGoogleAccessToken(fakeClientId, mockThrowsOauth2),
    (err: any) => {
      assert.ok(err instanceof CloudOperationError);
      assert.equal(err.diagnostic.stage, 'gis_token');
      assert.equal(err.diagnostic.reason, 'BlockedByClient');
      return true;
    },
  );
});

test('sanitizeCloudDiagnostic redacts OAuth secrets while keeping diagnostics safe', () => {
  const diagWithSecret = sanitizeCloudDiagnostic({
    stage: 'authorization',
    reason: 'token_rejected',
    errorMessage: 'Failed with bearer ya29.a0AfH6SMA... and client secret GOCSPX-secret123',
  });

  assert.equal(diagWithSecret.provider, 'googledrive');
  assert.equal(diagWithSecret.stage, 'authorization');
  assert.equal(diagWithSecret.reason, 'token_rejected');
  assert.doesNotMatch(diagWithSecret.errorMessage || '', /ya29\./);
  assert.doesNotMatch(diagWithSecret.errorMessage || '', /GOCSPX-/);
});

test('fetchAccount uses drive/v3/about when successful', async () => {
  const fakeFetch: typeof fetch = async (url: any) => {
    if (String(url).includes('drive/v3/about')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: {
            permissionId: 'perm-12345',
            displayName: 'Jane Doe',
            emailAddress: 'jane@example.com',
          },
        }),
      } as any;
    }
    throw new Error('Unexpected URL');
  };

  const account = await fetchAccount('mock-token', fakeFetch);
  assert.equal(account.id, 'perm-12345');
  assert.equal(account.name, 'Jane Doe');
  assert.equal(account.email, 'jane@example.com');
});

test('fetchAccount falls back to oauth2/v3/userinfo when drive/v3/about returns 403 or fails', async () => {
  let aboutCalled = false;
  let userinfoCalled = false;

  const fakeFetch: typeof fetch = async (url: any) => {
    const urlStr = String(url);
    if (urlStr.includes('drive/v3/about')) {
      aboutCalled = true;
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'Access Not Configured' } }),
      } as any;
    }
    if (urlStr.includes('oauth2/v3/userinfo')) {
      userinfoCalled = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sub: 'google-sub-67890',
          name: 'John Doe',
          email: 'john@example.com',
        }),
      } as any;
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };

  const account = await fetchAccount('mock-token', fakeFetch);
  assert.equal(aboutCalled, true);
  assert.equal(userinfoCalled, true);
  assert.equal(account.id, 'google-sub-67890');
  assert.equal(account.name, 'John Doe');
  assert.equal(account.email, 'john@example.com');
});

test('fetchAccount throws CloudOperationError when both about and userinfo endpoints fail', async () => {
  const fakeFetch: typeof fetch = async () => {
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    } as any;
  };

  await assert.rejects(
    fetchAccount('mock-token', fakeFetch),
    (err: any) => {
      assert.ok(err instanceof CloudOperationError);
      assert.equal(err.code, 'connection');
      assert.equal(err.diagnostic.stage, 'account_identity');
      assert.equal(err.diagnostic.reason, 'userinfo_unavailable');
      return true;
    },
  );
});

test('vercel.json specifies Cross-Origin-Opener-Policy same-origin-allow-popups', async () => {
  const raw = await fs.readFile('vercel.json', 'utf8');
  const parsed = JSON.parse(raw);
  const wildcardHeaderGroup = parsed.headers?.find((h: any) => h.source === '/(.*)');
  assert.ok(wildcardHeaderGroup, 'Wildcard header group should exist in vercel.json');

  const coopHeader = wildcardHeaderGroup.headers?.find(
    (h: any) => h.key === 'Cross-Origin-Opener-Policy',
  );
  assert.ok(coopHeader, 'Cross-Origin-Opener-Policy header must be configured');
  assert.equal(coopHeader.value, 'same-origin-allow-popups');
});

test('index.html includes Google Identity Services script tag', async () => {
  const html = await fs.readFile('index.html', 'utf8');
  assert.match(
    html,
    /<script\s+src="https:\/\/accounts\.google\.com\/gsi\/client"\s+async\s+defer><\/script>/,
  );
});


