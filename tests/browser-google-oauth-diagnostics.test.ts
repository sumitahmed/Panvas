import test from 'node:test';
import assert from 'node:assert/strict';
import { requestBrowserGoogleAccessToken } from '../src/services/cloudsync/browserGoogleAuth.ts';
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

