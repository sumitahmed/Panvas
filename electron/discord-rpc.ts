// ============================================
// Panvas — Discord Rich Presence (Desktop/Electron V1)
// ============================================
// Lightweight, standalone local IPC client for Discord Rich Presence.
// Uses Discord's local IPC named pipe / domain socket protocol.
// Does NOT require bot tokens, OAuth, webhooks, or external network servers.
// Privacy rule: Advertises only that Panvas is in use. Never exposes
// workspaces, notebooks, pages, PDF names, titles, or user content.

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const DISCORD_APP_ID = (
  process.env.PANVAS_DISCORD_APPLICATION_ID ||
  process.env.PANVAS_DISCORD_CLIENT_ID ||
  process.env.DISCORD_CLIENT_ID ||
  '1546879865997758576'
).trim();

export const DISCORD_ASSET_KEY = (
  process.env.PANVAS_DISCORD_ASSET_KEY ||
  process.env.DISCORD_ASSET_KEY ||
  'panvas-logo_1'
).trim();

export const DEFAULT_RECONNECT_INTERVAL_MS = 20_000;

export interface DiscordActivity {
  type: 0;
  details: string;
  assets: {
    large_image: string;
    large_text: string;
  };
}

export type DiscordRpcLogLevel = 'log' | 'warn' | 'error';
export type DiscordRpcLogger = (level: DiscordRpcLogLevel, message: string, ...args: unknown[]) => void;

export interface DiscordRpcOptions {
  clientId?: string;
  assetKey?: string;
  reconnectIntervalMs?: number;
  customPipePath?: string;
  debugLogs?: boolean;
  logger?: DiscordRpcLogger;
}

function isDevEnvironment(): boolean {
  return Boolean(
    process.env.VITE_DEV_SERVER_URL ||
    process.env.NODE_ENV === 'development' ||
    process.env.PANVAS_DEV_RPC === 'true' ||
    process.env.PANVAS_DEBUG_RPC === 'true'
  );
}

/**
 * Builds the canonical, privacy-safe Panvas Rich Presence payload.
 * Absolutely no workspace, notebook, page, document, or user data is included.
 */
export function buildPanvasActivity(assetKey: string = DISCORD_ASSET_KEY): DiscordActivity {
  return {
    type: 0,
    details: 'Using Panvas',
    assets: {
      large_image: assetKey,
      large_text: 'Panvas',
    },
  };
}

/**
 * Validates that an activity payload complies with the strict Panvas privacy rule:
 * only 'Using Panvas' details and the approved Panvas logo assets are allowed.
 */
export function validateActivityPrivacy(activity: unknown): boolean {
  if (!activity || typeof activity !== 'object') return false;
  const act = activity as Record<string, unknown>;
  if (act.type !== 0 || act.details !== 'Using Panvas') return false;

  const assets = act.assets as Record<string, unknown> | undefined;
  if (!assets || assets.large_image !== DISCORD_ASSET_KEY || assets.large_text !== 'Panvas') {
    return false;
  }

  const allowedTopLevel = new Set(['type', 'details', 'assets']);
  for (const key of Object.keys(act)) {
    if (!allowedTopLevel.has(key)) return false;
  }

  const allowedAssetKeys = new Set(['large_image', 'large_text']);
  for (const key of Object.keys(assets)) {
    if (!allowedAssetKeys.has(key)) return false;
  }

  return true;
}

export class DiscordPresenceService {
  private clientId: string;
  private assetKey: string;
  private reconnectIntervalMs: number;
  private customPipePath?: string;
  private debugLogs: boolean;
  private logger?: DiscordRpcLogger;

  private socket: net.Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
  private ready = false;
  private activityNonce: string | null = null;
  private activityConfirmed = false;
  private retryAttempts = 0;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isDestroyed = false;
  private buffer: Buffer = Buffer.alloc(0);

  constructor(options: DiscordRpcOptions = {}) {
    this.clientId = options.clientId ?? DISCORD_APP_ID;
    this.assetKey = options.assetKey ?? DISCORD_ASSET_KEY;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    this.customPipePath = options.customPipePath;
    this.debugLogs = options.debugLogs ?? isDevEnvironment();
    this.logger = options.logger;

    this.log(`RPC initialized (Application ID: ${this.clientId}, Asset Key: ${this.assetKey})`);
    this.logVerbose(`RPC initialized (Application ID: ${this.clientId}, Asset Key: ${this.assetKey})`);
  }

  private isVerbose(): boolean {
    return Boolean(process.env.PANVAS_DEBUG_RPC === 'true');
  }

  private log(message: string, ...args: unknown[]): void {
    if (!this.debugLogs) return;
    if (this.logger) {
      this.logger('log', message, ...args);
    } else {
      console.log(`[Discord RPC] ${message}`, ...args);
    }
  }

  private logVerbose(message: string, ...args: unknown[]): void {
    if (!this.debugLogs) return;
    if (this.logger) {
      this.logger('log', message, ...args);
    } else if (this.isVerbose()) {
      console.log(`[Discord RPC] ${message}`, ...args);
    }
  }

  private logWarn(message: string, ...args: unknown[]): void {
    if (!this.debugLogs) return;
    if (this.logger) {
      this.logger('warn', message, ...args);
    } else {
      console.warn(`[Discord RPC] ${message}`, ...args);
    }
  }

  private logError(message: string, ...args: unknown[]): void {
    if (!this.debugLogs) return;
    if (this.logger) {
      this.logger('error', message, ...args);
    } else {
      console.error(`[Discord RPC] ${message}`, ...args);
    }
  }

  /**
   * Starts the presence service. Attempts connection immediately;
   * if Discord is unavailable, schedules polite background retries.
   */
  public start(): void {
    if (this.isDestroyed || this.isConnected || this.isConnecting) return;
    this.log('Starting Discord Rich Presence service...');
    this.logVerbose('Starting Discord Rich Presence service...');
    void this.tryConnect();
  }

  /**
   * Returns whether the service is actively connected to a local Discord client.
   */
  public isConnectedToDiscord(): boolean {
    return this.ready && this.isConnected && this.socket !== null && !this.socket.destroyed;
  }

  public getStatus() {
    return {
      connected: this.isConnectedToDiscord(),
      ready: this.ready,
      activityConfirmed: this.activityConfirmed,
      destroyed: this.isDestroyed,
      connecting: this.isConnecting,
      reconnectTimerActive: this.reconnectTimer !== null,
    };
  }

  private getIpcPipePath(id: number): string {
    if (process.platform === 'win32') {
      return `\\\\?\\pipe\\discord-ipc-${id}`;
    }
    const env = process.env;
    const prefix = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
    return path.join(prefix, `discord-ipc-${id}`);
  }

  private connectToPath(pipePath: string): Promise<net.Socket | null> {
    return new Promise((resolve) => {
      let resolved = false;
      let socket: net.Socket;

      try {
        socket = net.createConnection(pipePath);
      } catch {
        return resolve(null);
      }

      const onConnect = () => {
        if (resolved) return;
        resolved = true;
        socket.setTimeout(0);
        socket.removeAllListeners('timeout');
        socket.removeListener('error', onError);
        resolve(socket);
      };

      const onError = () => {
        if (resolved) return;
        resolved = true;
        socket.removeListener('connect', onConnect);
        try {
          socket.destroy();
        } catch {
          // Ignore
        }
        resolve(null);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);

      socket.setTimeout(2500, () => {
        if (!resolved) {
          resolved = true;
          try {
            socket.destroy();
          } catch {
            // Ignore
          }
          resolve(null);
        }
      });
    });
  }

  private async findAndConnectPipe(): Promise<net.Socket | null> {
    if (this.customPipePath) {
      return this.connectToPath(this.customPipePath);
    }
    for (let i = 0; i < 10; i++) {
      if (this.isDestroyed) return null;
      const pipePath = this.getIpcPipePath(i);
      const socket = await this.connectToPath(pipePath);
      if (socket) {
        return socket;
      }
    }
    return null;
  }

  private async tryConnect(): Promise<void> {
    if (this.isDestroyed || this.isConnected || this.isConnecting) return;
    this.isConnecting = true;
    this.log('Connecting to local Discord IPC...');
    this.logVerbose('Connecting to local Discord IPC...');

    try {
      const socket = await this.findAndConnectPipe();
      if (socket && !this.isDestroyed) {
        this.setupConnectedSocket(socket);
      } else if (socket) {
        socket.destroy();
      } else if (!this.isDestroyed) {
        this.logWarn('Connection failure: no available local Discord IPC pipe.');
        this.scheduleReconnect();
      }
    } catch (err) {
      if (!this.isDestroyed) {
        this.logError('Connection error while seeking Discord IPC pipe:', err);
        this.scheduleReconnect();
      }
    } finally {
      this.isConnecting = false;
    }
  }

  private setupConnectedSocket(socket: net.Socket): void {
    this.socket = socket;
    this.isConnected = true;
    this.buffer = Buffer.alloc(0);
    this.log('Connected to Discord IPC named pipe successfully.');
    this.logVerbose('Connected to Discord IPC named pipe successfully.');
    if (!this.logger && this.debugLogs && !this.isVerbose()) {
      console.log('[Discord RPC] Connected');
    }
    this.log('Connected');

    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 8) {
        const opcode = this.buffer.readUInt32LE(0);
        const length = this.buffer.readUInt32LE(4);
        if (length > 1024 * 1024) {
          this.logError(`Discord frame exceeds size limit: ${length} bytes.`);
          this.handleSocketTermination();
          return;
        }
        if (this.buffer.length < 8 + length) {
          break; // Await remaining frame bytes
        }
        const payloadBuf = this.buffer.subarray(8, 8 + length);
        this.buffer = this.buffer.subarray(8 + length);
        this.handleFrame(opcode, payloadBuf);
        if (this.socket !== socket) return;
      }
    });

    socket.on('error', (err) => {
      if (this.socket !== socket) return;
      this.logWarn('Discord IPC socket error:', err.message);
      this.handleSocketTermination();
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.log('Discord IPC socket closed.');
      this.logVerbose('Discord IPC socket closed.');
      this.handleSocketTermination();
    });

    // Send initial handshake (opcode 0)
    this.handshakeTimer = setTimeout(() => {
      this.logWarn('Discord READY timeout after 10 seconds.');
      this.handleSocketTermination();
    }, 10_000);
    this.handshakeTimer.unref();
    this.sendHandshake();
  }

  private handleSocketTermination(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.ready = false;
    this.activityNonce = null;
    this.activityConfirmed = false;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // Ignore
      }
      this.socket = null;
    }
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.buffer = Buffer.alloc(0);

    if (wasConnected) {
      this.log('Discord IPC connection terminated.');
      this.logVerbose('Discord IPC connection terminated.');
    }

    if (!this.isDestroyed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.isDestroyed || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectIntervalMs * 2 ** Math.min(this.retryAttempts++, 8), 300_000);
    this.log(`Retrying Discord IPC in ${Math.round(delay / 1000)}s.`);
    this.logVerbose(`Retrying Discord IPC in ${Math.round(delay / 1000)}s.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnect();
    }, delay);

    // Unref timer so it never holds Node/Electron process open
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  private sendFrame(opcode: number, payload: unknown): boolean {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
    try {
      const payloadBuf = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(JSON.stringify(payload), 'utf8');
      const headerBuf = Buffer.alloc(8);
      headerBuf.writeUInt32LE(opcode, 0);
      headerBuf.writeUInt32LE(payloadBuf.length, 4);
      this.socket.write(Buffer.concat([headerBuf, payloadBuf]));
      return true;
    } catch (err) {
      this.logError(`Failed writing frame (opcode ${opcode}) to socket:`, err);
      return false;
    }
  }

  private sendHandshake(): void {
    const sent = this.sendFrame(0 /* HANDSHAKE */, {
      v: 1,
      client_id: this.clientId,
    });
    if (sent) {
      this.log(`Handshake sent to Discord (client_id: ${this.clientId}).`);
      this.logVerbose(`Handshake sent to Discord (client_id: ${this.clientId}).`);
    } else {
      this.logError(`Failed to send handshake to Discord.`);
      this.handleSocketTermination();
    }
  }

  public sendActivity(): void {
    if (!this.ready || this.activityNonce) return;
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      this.logError('Cannot publish activity: Discord IPC socket is not connected or writable.');
      return;
    }
    const activity = buildPanvasActivity(this.assetKey);
    const nonce = `panvas-${randomUUID()}`;
    this.activityNonce = nonce;
    this.activityConfirmed = false;
    const payload = { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce };
    this.logVerbose(`Outgoing SET_ACTIVITY payload: ${JSON.stringify(payload)}`);
    const sent = this.sendFrame(1 /* FRAME */, payload);
    if (sent) {
      this.logVerbose(
        `Activity sent; awaiting Discord acknowledgment: "${activity.details}" (large_image: "${activity.assets.large_image}", large_text: "${activity.assets.large_text}").`
      );
    } else {
      this.activityNonce = null;
      this.logError('Activity publish failure: unable to write frame to Discord IPC socket.');
    }
  }

  public clearActivity(): void {
    if (!this.ready) return;
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;
    const sent = this.sendFrame(1 /* FRAME */, {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: null,
      },
      nonce: `panvas-clear-${Date.now()}`,
    });
    if (sent) {
      this.log('Clear activity sent; acknowledgment not yet confirmed.');
      this.logVerbose('Clear activity sent; acknowledgment not yet confirmed.');
    } else {
      this.logError('Failed to clear presence activity.');
    }
  }

  private handleFrame(opcode: number, payloadBuf: Buffer): void {
    if (opcode === 1 /* FRAME */) {
      try {
        const data = JSON.parse(payloadBuf.toString('utf8'));
        if (data?.evt === 'READY' && data.cmd === 'DISPATCH' && !this.ready) {
          this.ready = true;
          if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
          this.log('Discord IPC handshake confirmed (READY). Publishing Panvas presence activity...');
          this.logVerbose('Discord IPC handshake confirmed (READY). Publishing Panvas presence activity...');
          this.sendActivity();
        } else if (data?.cmd === 'SET_ACTIVITY' && this.activityNonce !== null && data.nonce === this.activityNonce) {
          this.log(`Matching SET_ACTIVITY response: ${payloadBuf.toString('utf8')}`);
          this.logVerbose(`Matching SET_ACTIVITY response: ${payloadBuf.toString('utf8')}`);
          this.activityNonce = null;
          if (data.evt === 'ERROR') {
            this.logError(`Activity publish rejected by Discord: code=${JSON.stringify(data.data?.code ?? null)}, message=${JSON.stringify(data.data?.message ?? null)}, payload=${JSON.stringify(data)}`);
          } else if (data.evt == null) {
            this.activityConfirmed = true;
            this.retryAttempts = 0;
            this.log('Discord acknowledged SET_ACTIVITY; visibility in Discord UI is not verified.');
            this.logVerbose('Discord acknowledged SET_ACTIVITY; visibility in Discord UI is not verified.');
            if (!this.logger && this.debugLogs && !this.isVerbose()) {
              console.log('[Discord RPC] Presence active');
            }
            this.log('Presence active');
          } else {
            this.logWarn(`Unexpected SET_ACTIVITY event; not acknowledged: ${JSON.stringify(data.evt)}`);
          }
        }
      } catch {
        this.logWarn('Malformed Discord FRAME payload:', payloadBuf.toString('utf8'));
      }
    } else if (opcode === 2 /* CLOSE */) {
      const raw = payloadBuf.toString('utf8');
      try {
        const payload = JSON.parse(raw);
        this.logError(`Discord CLOSE (opcode 2): code=${JSON.stringify(payload?.code ?? null)}, message=${JSON.stringify(payload?.message ?? null)}, payload=${raw}`);
      } catch {
        this.logError(`Discord CLOSE (opcode 2): non-JSON raw payload=${raw}; hex=${payloadBuf.toString('hex')}`);
      }
      this.handleSocketTermination();
    } else if (opcode === 3 /* PING */) {
      this.sendFrame(4 /* PONG */, payloadBuf);
    }
  }

  /**
   * Destroys the presence service, clears activity if connected,
   * cancels all reconnect timers, and cleans up sockets.
   */
  public destroy(): void {
    this.log('Destroying Discord Rich Presence service.');
    this.logVerbose('Destroying Discord Rich Presence service.');
    this.isDestroyed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        if (this.isConnected && !this.socket.destroyed && this.socket.writable) {
          this.clearActivity();
        }
      } catch {
        // Ignore
      }
      try {
        this.socket.destroy();
      } catch {
        // Ignore
      }
      this.socket = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.ready = false;
    this.activityConfirmed = false;
  }
}

// Global active instance for Electron lifecycle management
let activeService: DiscordPresenceService | null = null;

export function initDiscordRpc(options?: DiscordRpcOptions): DiscordPresenceService {
  if (activeService) {
    activeService['log']?.('initDiscordRpc: Reusing existing active service instance.');
    activeService['logVerbose']?.('initDiscordRpc: Reusing existing active service instance.');
    return activeService;
  }
  activeService = new DiscordPresenceService(options);
  activeService.start();
  return activeService;
}

export function destroyDiscordRpc(): void {
  if (activeService) {
    activeService.destroy();
    activeService = null;
  }
}

export function getDiscordRpcService(): DiscordPresenceService | null {
  return activeService;
}

