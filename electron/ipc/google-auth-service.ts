import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import type { ProviderConnectionInfo } from '../../src/services/cloudsync/types';
import { generateRandomString, generateCodeChallenge } from '../../src/services/cloudsync/pkce.ts';

export { generateRandomString, generateCodeChallenge };

const TOKEN_FILE_NAME = 'google_auth_tokens.enc';

export function resolveGoogleTokenFilePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const roaming = env.APPDATA || (env.USERPROFILE ? platformPath.join(env.USERPROFILE, 'AppData', 'Roaming') : '');
    return roaming ? platformPath.join(roaming, 'Panvas', TOKEN_FILE_NAME) : '';
  }
  if (platform === 'darwin') {
    const home = env.HOME || env.USERPROFILE || '';
    return home ? platformPath.join(home, 'Library', 'Application Support', 'Panvas', TOKEN_FILE_NAME) : '';
  }
  const config = env.XDG_CONFIG_HOME || ((env.HOME || env.USERPROFILE) ? platformPath.join(env.HOME || env.USERPROFILE || '', '.config') : '');
  return config ? platformPath.join(config, 'Panvas', TOKEN_FILE_NAME) : '';
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in ms
  accountIdentifier: string;
  displayName?: string;
  email?: string;
  connectedAt: number;
}

export interface GoogleAuthServiceOptions {
  tokenFilePath?: string;
  tokenEndpoint?: string;
  authEndpoint?: string;
  revokeEndpoint?: string;
  userinfoEndpoint?: string;
  fetchFn?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  openExternal?: (url: string) => Promise<void>;
}

export class GoogleAuthDiagnosticError extends Error {
  readonly stage: string;
  readonly status?: number;
  readonly reason: string;
  readonly publicMessage: string;
  constructor(input: { stage: string; reason: string; status?: number; publicMessage?: string }) {
    super('Google authorization operation failed.');
    this.name = 'GoogleAuthDiagnosticError';
    this.stage = input.stage; this.reason = input.reason; this.status = input.status;
    this.publicMessage = input.publicMessage ?? "Google Drive couldn't be connected. Please try again.";
  }
}

function ensureEnvLoaded(): void {
  try {
    dotenv.config({ path: path.join(process.cwd(), '.env') });
    dotenv.config({ path: path.join(process.cwd(), '.env.local') });
    if (process.env.APP_ROOT && process.env.APP_ROOT !== process.cwd()) {
      dotenv.config({ path: path.join(process.env.APP_ROOT, '.env') });
      dotenv.config({ path: path.join(process.env.APP_ROOT, '.env.local') });
    }
  } catch {
    // Graceful fallback if files or dotenv are unavailable
  }
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress)';

const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata';

async function getElectronModule() {
  try {
    return await import('electron');
  } catch {
    return null;
  }
}

const DEFAULT_GOOGLE_CLIENT_ID = process.env.PANVAS_GOOGLE_CLIENT_ID || '';
const DEFAULT_GOOGLE_CLIENT_SECRET = process.env.PANVAS_GOOGLE_CLIENT_SECRET || '';

export class GoogleAuthService {
  private tokenFilePath: string;
  private tokenEndpoint: string;
  private authEndpoint: string;
  private revokeEndpoint: string;
  private userinfoEndpoint: string;
  private fetchFn: typeof fetch;
  private openExternal?: (url: string) => Promise<void>;
  private defaultClientId?: string;
  private defaultClientSecret?: string;
  private tokenOperation: Promise<void> = Promise.resolve();
  private tokenGeneration = 0;
  private activeAuthServer: { close: () => void; port?: number } | null = null;

  constructor(options: GoogleAuthServiceOptions = {}) {
    this.tokenFilePath = options.tokenFilePath || '';
    this.tokenEndpoint = options.tokenEndpoint || GOOGLE_TOKEN_ENDPOINT;
    this.authEndpoint = options.authEndpoint || GOOGLE_AUTH_ENDPOINT;
    this.revokeEndpoint = options.revokeEndpoint || GOOGLE_REVOKE_ENDPOINT;
    this.userinfoEndpoint = options.userinfoEndpoint || GOOGLE_USERINFO_ENDPOINT;
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
    this.openExternal = options.openExternal;
    this.defaultClientId = options.clientId;
    this.defaultClientSecret = options.clientSecret;
  }

  private resolveClientId(custom?: string): string {
    if (custom !== undefined) return custom.trim();
    if (this.defaultClientId !== undefined) return this.defaultClientId.trim();
    ensureEnvLoaded();
    return (process.env.PANVAS_GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID).trim();
  }

  private resolveClientSecret(custom?: string): string {
    if (custom !== undefined) return custom.trim();
    if (this.defaultClientSecret !== undefined) return this.defaultClientSecret.trim();
    ensureEnvLoaded();
    // Accept the historical short name as well; keep the secret main-process only.
    return (process.env.PANVAS_GOOGLE_CLIENT_SECRET || process.env.PANVAS_GOOGLE_SECRET || DEFAULT_GOOGLE_CLIENT_SECRET).trim();
  }

  private async resolveTokenFilePath(): Promise<string> {
    if (this.tokenFilePath) return this.tokenFilePath;
    const electron = await getElectronModule();
    if (electron?.app?.getPath) {
      const userDataPath = electron.app.getPath('userData');
      if (userDataPath) {
        this.tokenFilePath = path.join(userDataPath, TOKEN_FILE_NAME);
        return this.tokenFilePath;
      }
    }
    this.tokenFilePath = resolveGoogleTokenFilePath();
    return this.tokenFilePath;
  }

  /**
   * Starts the Google OAuth 2.0 PKCE flow on the system browser via loopback server.
   */
  async startAuthFlow(customClientId?: string, customClientSecret?: string): Promise<ProviderConnectionInfo> {
    // If a previous auth loopback server is still active, close it cleanly
    if (this.activeAuthServer) {
      try {
        this.activeAuthServer.close();
      } catch {
        // Ignore close error on superseded server
      }
      this.activeAuthServer = null;
    }

    // Invalidate any earlier in-flight auth callbacks
    this.tokenGeneration += 1;
    const authGeneration = this.tokenGeneration;

    const clientId = this.resolveClientId(customClientId);
    const clientSecret = this.resolveClientSecret(customClientSecret);

    if (!clientId) {
      throw new GoogleAuthDiagnosticError({ stage: 'configuration', reason: 'missing_client_id', publicMessage: 'Google Drive sign-in is temporarily unavailable.' });
    }

    const codeVerifier = generateRandomString(48);
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateRandomString(24);

    return new Promise((resolve, reject) => {
      let resolved = false;

      // Start loopback HTTP server on an available port
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || '/', `http://${req.headers.host}`);
          if (reqUrl.pathname !== '/oauth2callback') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }

          const incomingState = reqUrl.searchParams.get('state');
          if (incomingState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(await this.renderHtmlResponse(false, 'Invalid state or missing authorization code.'));
            cleanup();
            if (!resolved) {
              resolved = true;
              reject(new GoogleAuthDiagnosticError({ stage: 'authorization_callback', reason: 'invalid_state' }));
            }
            return;
          }

          const errorParam = reqUrl.searchParams.get('error');
          if (errorParam) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(await this.renderHtmlResponse(false, "Google Drive couldn't be connected. Please return to Panvas and try again."));
            cleanup();
            if (!resolved) {
              resolved = true;
              reject(new GoogleAuthDiagnosticError({ stage: 'authorization_callback', reason: errorParam }));
            }
            return;
          }

          const code = reqUrl.searchParams.get('code');

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(await this.renderHtmlResponse(false, 'Invalid state or missing authorization code.'));
            cleanup();
            if (!resolved) {
              resolved = true;
              reject(new GoogleAuthDiagnosticError({ stage: 'authorization_callback', reason: 'invalid_state' }));
            }
            return;
          }

          // Exchange code for tokens (includes client_secret if configured)
          const tokens = await this.exchangeCodeForTokens({
            clientId,
            clientSecret,
            code,
            codeVerifier,
            redirectUri: `http://127.0.0.1:${port}/oauth2callback`,
          });

          // Fetch user info for UI presentation
          const userInfo = await this.fetchUserInfo(tokens.access_token);

          // Check if an existing connection exists for this account so we can preserve refresh_token if Google omitted it
          const existing = await this.readStoredTokens();
          const isSameAccount = Boolean(existing && existing.accountIdentifier === userInfo.id);
          const refreshToken = tokens.refresh_token || (isSameAccount && existing ? existing.refreshToken : '');

          const storedData: StoredTokens = {
            accessToken: tokens.access_token,
            refreshToken,
            expiresAt: Date.now() + tokens.expires_in * 1000,
            accountIdentifier: userInfo.id,
            displayName: userInfo.name || existing?.displayName,
            email: userInfo.email || existing?.email,
            connectedAt: isSameAccount && existing ? existing.connectedAt : Date.now(),
          };

          await this.withTokenOperation(async () => {
            if (this.tokenGeneration !== authGeneration) {
              throw new GoogleAuthDiagnosticError({ stage: 'authorization', reason: 'connection_superseded' });
            }
            await this.saveTokens(storedData);
          });

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(await this.renderHtmlResponse(true, 'Google Drive connected successfully!'));

          if (!resolved) {
            resolved = true;
            resolve({
              provider: 'googledrive',
              accountIdentifier: storedData.accountIdentifier,
              displayName: storedData.displayName,
              email: storedData.email,
              connectedAt: storedData.connectedAt,
            });
          }
          cleanup();
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          const publicMessage = err instanceof GoogleAuthDiagnosticError ? err.publicMessage : "Google Drive couldn't be connected. Please return to Panvas and try again.";
          res.end(await this.renderHtmlResponse(false, publicMessage));
          cleanup();
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        }
      });

      let port = 0;

      server.listen(0, '127.0.0.1', async () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          cleanup();
          reject(new GoogleAuthDiagnosticError({ stage: 'loopback_server', reason: 'server_start_failed' }));
          return;
        }

        port = address.port;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const authUrl = this.buildAuthUrl({ clientId, redirectUri, state, codeChallenge });
        activeServerHandle.port = port;

        if (this.openExternal) {
          void this.openExternal(authUrl);
        } else {
          const electron = await getElectronModule();
          if (electron?.shell?.openExternal) {
            void electron.shell.openExternal(authUrl);
          }
        }
      });

      const timeout = setTimeout(() => {
        cleanup();
        if (!resolved) {
          resolved = true;
          reject(new GoogleAuthDiagnosticError({ stage: 'authorization', reason: 'timeout' }));
        }
      }, 120_000); // 2 minute timeout

      const cleanup = () => {
        clearTimeout(timeout);
        if (this.activeAuthServer === activeServerHandle) {
          this.activeAuthServer = null;
        }
        try {
          server.close();
        } catch {
          // ignore close errors
        }
      };

      // Resource cleanup must not settle the flow. Only an explicit close
      // (including superseding authorization) represents cancellation.
      const activeServerHandle: { close: () => void; port?: number } = {
        close: () => {
          if (!resolved) {
            resolved = true;
            reject(new GoogleAuthDiagnosticError({ stage: 'authorization', reason: 'cancelled' }));
          }
          cleanup();
        },
      };
      this.activeAuthServer = activeServerHandle;
    });
  }

  buildAuthUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
    const authParams = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      state: input.state,
      access_type: 'offline',
      prompt: 'consent select_account',
    });
    return `${this.authEndpoint}?${authParams.toString()}`;
  }

  /**
   * Reads stored connection info (without exposing secret access tokens).
   */
  async getConnectionInfo(): Promise<ProviderConnectionInfo | null> {
    const stored = await this.readStoredTokens();
    if (!stored) return null;
    return {
      provider: 'googledrive',
      accountIdentifier: stored.accountIdentifier,
      displayName: stored.displayName,
      email: stored.email,
      connectedAt: stored.connectedAt,
    };
  }

  /**
   * Retrieves a valid access token, automatically refreshing it if expired.
   */
  async getValidAccessToken(customClientId?: string, customClientSecret?: string): Promise<string | null> {
    return this.withTokenOperation(async () => {
      const stored = await this.readStoredTokens();
      if (!stored) return null;

      // If access token is still valid (with 60s margin), use it
      if (Date.now() < stored.expiresAt - 60_000) return stored.accessToken;

      // Refresh if refresh token exists
      if (!stored.refreshToken) return null;

      const clientId = this.resolveClientId(customClientId);
      const clientSecret = this.resolveClientSecret(customClientSecret);
      if (!clientId) return null;

      try {
        const refreshed = await this.refreshAccessToken(clientId, stored.refreshToken, clientSecret);
        stored.accessToken = refreshed.access_token;
        stored.expiresAt = Date.now() + refreshed.expires_in * 1000;
        if (refreshed.refresh_token) stored.refreshToken = refreshed.refresh_token;
        await this.saveTokens(stored);
        return stored.accessToken;
      } catch (error) {
        if (error instanceof GoogleAuthDiagnosticError && [400, 401, 403].includes(error.status ?? 0)) return null;
        throw error;
      }
    });
  }

  /** Force refresh after Drive rejects an otherwise locally unexpired token. */
  async forceRefreshAccessToken(customClientId?: string, customClientSecret?: string): Promise<string | null> {
    return this.withTokenOperation(async () => {
      const stored = await this.readStoredTokens();
      if (!stored?.refreshToken) return null;
      const clientId = this.resolveClientId(customClientId);
      if (!clientId) return null;
      try {
        const refreshed = await this.refreshAccessToken(clientId, stored.refreshToken, this.resolveClientSecret(customClientSecret));
        stored.accessToken = refreshed.access_token;
        stored.expiresAt = Date.now() + refreshed.expires_in * 1000;
        if (refreshed.refresh_token) stored.refreshToken = refreshed.refresh_token;
        await this.saveTokens(stored);
        return stored.accessToken;
      } catch (error) {
        if (error instanceof GoogleAuthDiagnosticError && [400, 401, 403].includes(error.status ?? 0)) return null;
        throw error;
      }
    });
  }

  /**
   * Disconnects Google Drive by revoking tokens and deleting encrypted storage.
   */
  async disconnect(): Promise<void> {
    await this.withTokenOperation(async () => {
      this.tokenGeneration += 1;
      const stored = await this.readStoredTokens();
      if (stored?.refreshToken || stored?.accessToken) {
        try {
          const tokenToRevoke = stored.refreshToken || stored.accessToken;
          await this.fetchFn(`${this.revokeEndpoint}?token=${encodeURIComponent(tokenToRevoke)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          });
        } catch {
          // Revocation network errors do not block local token cleanup
        }
      }
      await this.deleteTokens();
    });
  }

  /**
   * Exchanges an authorization code for access and refresh tokens.
   * Includes `client_secret` in the POST body if configured (required by Google Desktop OAuth clients).
   */
  async exchangeCodeForTokens(input: {
    clientId: string;
    clientSecret?: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const params = new URLSearchParams({
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    });

    if (input.clientSecret) {
      params.set('client_secret', input.clientSecret);
    }

    const response = await this.fetchFn(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const reason = await this.readProviderReason(response);
      throw new GoogleAuthDiagnosticError({ stage: 'token_exchange', status: response.status, reason });
    }

    return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
  }

  /**
   * Refreshes an expired access token using the stored refresh token.
   * Includes `client_secret` in the POST body if configured.
   */
  async refreshAccessToken(
    clientId: string,
    refreshToken: string,
    clientSecret?: string,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const params = new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    if (clientSecret) {
      params.set('client_secret', clientSecret);
    }

    const response = await this.fetchFn(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const reason = await this.readProviderReason(response);
      throw new GoogleAuthDiagnosticError({ stage: 'token_refresh', status: response.status, reason, publicMessage: 'Google Drive needs to be reconnected.' });
    }

    return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
  }

  async fetchUserInfo(accessToken: string): Promise<{ id: string; email?: string; name?: string }> {
    try {
      const response = await this.fetchFn(this.userinfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        const reason = await this.readProviderReason(response);
        throw new GoogleAuthDiagnosticError({ stage: 'userinfo', status: response.status, reason });
      }
      const value = await response.json() as { user?: { permissionId?: string; emailAddress?: string; displayName?: string } };
      const id = value.user?.permissionId ?? value.user?.emailAddress;
      if (typeof id !== 'string' || !id.trim()) {
        throw new GoogleAuthDiagnosticError({ stage: 'userinfo', reason: 'userinfo_identity_missing' });
      }
      return { id: id.trim(), email: value.user?.emailAddress, name: value.user?.displayName };
    } catch (error) {
      if (error instanceof GoogleAuthDiagnosticError) throw error;
      throw new GoogleAuthDiagnosticError({ stage: 'userinfo', reason: 'userinfo_unavailable' });
    }
  }

  private async readProviderReason(response: Response): Promise<string> {
    try {
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      const reason = typeof parsed?.error === 'string'
        ? parsed.error
        : parsed?.error?.status ?? parsed?.error?.errors?.[0]?.reason ?? response.statusText ?? 'provider_error';
      return String(reason).replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80);
    } catch { return String(response.statusText || 'provider_error').replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80); }
  }

  private async saveTokens(tokens: StoredTokens): Promise<void> {
    const filePath = await this.resolveTokenFilePath();
    if (!filePath) return;
    const json = JSON.stringify(tokens);
    let payload: Buffer;
    const electron = await getElectronModule();
    if (electron?.safeStorage?.isEncryptionAvailable?.()) {
      payload = electron.safeStorage.encryptString(json);
    } else {
      throw new GoogleAuthDiagnosticError({ stage: 'secure_storage', reason: 'secure_storage_unavailable', publicMessage: "Google Drive couldn't be connected. Please try again." });
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, payload);
  }

  private async readStoredTokens(): Promise<StoredTokens | null> {
    const filePath = await this.resolveTokenFilePath();
    if (!filePath) return null;
    try {
      const data = await fs.readFile(filePath);
      let json: string;
      const electron = await getElectronModule();
      if (!electron?.safeStorage?.isEncryptionAvailable?.()) return null;
      try { json = electron.safeStorage.decryptString(data); } catch { return null; }
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  private async deleteTokens(): Promise<void> {
    const filePath = await this.resolveTokenFilePath();
    if (!filePath) return;
    try {
      await fs.unlink(filePath);
    } catch {
      // File may already not exist
    }
  }

  private async withTokenOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tokenOperation;
    let release!: () => void;
    this.tokenOperation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async resolvePanvasLogoDataUri(): Promise<string> {
    const roots = [
      process.env.VITE_PUBLIC,
      process.env.APP_ROOT ? path.join(process.env.APP_ROOT, 'dist') : undefined,
      process.env.APP_ROOT ? path.join(process.env.APP_ROOT, 'public') : undefined,
      path.join(process.cwd(), 'dist'),
      path.join(process.cwd(), 'public'),
    ].filter((root): root is string => Boolean(root));

    for (const root of roots) {
      try {
        const bytes = await fs.readFile(path.join(root, 'panvas_logo.png'));
        return `data:image/png;base64,${bytes.toString('base64')}`;
      } catch {
        // The next candidate covers packaged, development, and test layouts.
      }
    }

    // Keep the callback usable if an incomplete package omits public assets.
    // Normal builds always resolve the canonical PNG above.
    return 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" rx="8" fill="%2320231f"/%3E%3Cpath d="M11 22V10h5.2c3.4 0 5.4 1.7 5.4 4.5s-2 4.5-5.4 4.5H14" fill="none" stroke="%23f8f5ed" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/%3E%3C/svg%3E';
  }

  private async renderHtmlResponse(success: boolean, message: string): Promise<string> {
    const title = success ? 'Google Drive connected' : 'Connection needs attention';
    const accentColor = success ? '#2f6f55' : '#b64b42';
    const safeMessage = message.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
    // The callback is self-contained for the system browser, so embed the
    // exact canonical Panvas mark used by the app rather than a second SVG
    // approximation that can drift from the product branding.
    const brandMark = await this.resolvePanvasLogoDataUri();
    const statusIcon = success
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5m0 3h.01" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/></svg>';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f2ea;
      color: #28251f;
      min-height: 100vh;
      margin: 0;
      padding: 0 24px;
    }
    .shell { width: 100%; max-width: 520px; margin: 0 auto; padding: 56px 0 72px; }
    .brand { display: flex; align-items: center; gap: 10px; color: #4c463c; font-size: 13px; font-weight: 650; letter-spacing: .02em; }
    .brand-mark { display: block; width: 28px; height: 28px; border-radius: 8px; object-fit: cover; }
    .crumb { margin: 20px 0 12px; color: #8a8174; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
    .card {
      background: #fffdf8;
      border: 1px solid #d9d0c1;
      border-radius: 14px;
      padding: 28px;
      box-shadow: 0 14px 32px rgba(58, 49, 35, .09);
    }
    .icon { 
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: ${accentColor}18;
      color: ${accentColor};
      margin-bottom: 18px;
    }
    .icon svg { width: 22px; height: 22px; }
    h1 {
      font-size: 21px;
      line-height: 1.25;
      font-weight: 700;
      letter-spacing: -.02em;
      margin: 0 0 10px;
    }
    p {
      font-size: 14px;
      color: #665f54;
      margin: 0;
      line-height: 1.55;
    }
    .actions { display: flex; justify-content: flex-start; margin-top: 24px; }
    button {
      border: 1px solid #cfc4b3;
      border-radius: 8px;
      background: #28251f;
      border-color: #28251f;
      color: #fffdf8;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      padding: 9px 15px;
    }
    button:hover { background: #403a32; border-color: #403a32; }
    button:focus-visible { outline: 3px solid rgba(47, 111, 85, .28); outline-offset: 2px; }
    .hint {
      font-size: 12px;
      color: #8a8174;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="brand"><img class="brand-mark" src="${brandMark}" alt="Panvas"><span>Panvas</span></div>
    <div class="crumb">Google Drive connection</div>
    <section class="card" aria-live="polite">
      <div class="icon">${statusIcon}</div>
      <h1>${title}</h1>
      <p>${safeMessage}</p>
      <div class="actions"><button type="button" onclick="closeCallbackTab()">Close this tab</button></div>
      <div class="hint">Close this tab to return to the Panvas window.</div>
    </section>
  </main>
  <script>
    function closeCallbackTab() {
      window.close();
      window.setTimeout(function () {
        var hint = document.querySelector('.hint');
        if (hint) hint.textContent = 'Chrome may block script-closing. Press Ctrl+W or use the tab’s X.';
      }, 120);
    }
  </script>
</body>
</html>`;
  }
}

export const googleAuthService = new GoogleAuthService();
