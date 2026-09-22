import type { CloudSyncStatus, SafeCloudDiagnostic, SyncEntityKind } from './types.ts';

export type CloudErrorCode = 'configuration' | 'connection' | 'offline' | 'auth-expired' | 'rate-limited' | 'conflict' | 'review' | 'payload' | 'remote-workspace' | 'remote-account-conflict' | 'account-migration-required' | 'cloud-not-initialized' | 'sync';

const PUBLIC_MESSAGES: Record<CloudErrorCode, string> = {
  configuration: 'Google Drive sign-in is temporarily unavailable.',
  connection: "Couldn't connect to Google Drive. Please try again.",
  offline: "You're offline. Changes will sync when you're back online.",
  'auth-expired': 'Google Drive needs to be reconnected.',
  'rate-limited': "Google Drive is busy. We'll retry when you ask us to sync again.",
  conflict: 'This workspace changed both here and in Google Drive. Choose which version to keep. Your local work is safe.',
  review: 'Some changes need review. Your work was preserved.',
  payload: "Couldn't sync right now. Your local work is safe.",
  'remote-workspace': 'An older synced workspace needs recovery. Your other workspaces can continue syncing. Your local work is safe.',
  'remote-account-conflict': 'This Google Drive account already contains a different Panvas sync space. Nothing was changed.',
  'account-migration-required': 'This local sync is linked to another Google account. Choose “Use this account” to move it safely, or reconnect the account that owns it.',
  'cloud-not-initialized': 'Cloud storage has not been initialized from an existing Panvas device yet.',
  sync: "Couldn't sync right now. Your local work is safe.",
};

function safeAtom(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80);
  return normalized || fallback;
}

const ENTITY_KINDS = new Set<SyncEntityKind>(['workspace', 'folder', 'notebook', 'notebookSection', 'notebookPage', 'pageContent', 'pageDrawing', 'canvasFile', 'canvasScene', 'customBlock', 'asset']);

/** Allowlisted diagnostic boundary shared by renderer logging and Electron IPC. */
export function sanitizeCloudDiagnostic(value: unknown): SafeCloudDiagnostic {
  const candidate = value && typeof value === 'object' ? value as Partial<SafeCloudDiagnostic> : {};
  const entityKind = ENTITY_KINDS.has(candidate.entityKind as SyncEntityKind) ? candidate.entityKind as SyncEntityKind : undefined;
  const status = typeof candidate.status === 'number' && Number.isInteger(candidate.status) && candidate.status >= 100 && candidate.status <= 599 ? candidate.status : undefined;
  const extra: Partial<SafeCloudDiagnostic> = {};
  if (candidate.schemaVersion !== undefined) extra.schemaVersion = safeAtom(candidate.schemaVersion, 'unknown');
  if (candidate.parentId === null) extra.parentId = null;
  else if (typeof candidate.parentId === 'string' && candidate.parentId) extra.parentId = safeAtom(candidate.parentId, 'unknown');
  if (candidate.errorClass) extra.errorClass = safeAtom(candidate.errorClass, 'unknown');
  if (candidate.throwingFunction) extra.throwingFunction = safeAtom(candidate.throwingFunction, 'unknown');
  if (candidate.errorMessage) extra.errorMessage = safeAtom(candidate.errorMessage, 'unknown');
  return {
    provider: 'googledrive',
    workspaceId: candidate.workspaceId ? safeAtom(candidate.workspaceId, 'unknown') : undefined,
    stage: safeAtom(candidate.stage, 'unknown'),
    status,
    reason: safeAtom(candidate.reason, 'unknown'),
    entityKind,
    entityId: candidate.entityId ? safeAtom(candidate.entityId, 'unknown') : undefined,
    operation: candidate.operation ? safeAtom(candidate.operation, 'unknown') : undefined,
    retryable: Boolean(candidate.retryable),
    ...extra,
  };
}

export class CloudOperationError extends Error {
  readonly code: CloudErrorCode;
  readonly diagnostic: SafeCloudDiagnostic;
  constructor(code: CloudErrorCode, diagnostic: Partial<SafeCloudDiagnostic> & Pick<SafeCloudDiagnostic, 'stage' | 'reason'>) {
    super(PUBLIC_MESSAGES[code]);
    this.name = 'CloudOperationError';
    this.code = code;
    this.diagnostic = sanitizeCloudDiagnostic({
      provider: 'googledrive', stage: safeAtom(diagnostic.stage, 'unknown'), reason: safeAtom(diagnostic.reason, 'unknown'),
      status: typeof diagnostic.status === 'number' ? diagnostic.status : undefined,
      workspaceId: diagnostic.workspaceId ? safeAtom(diagnostic.workspaceId, 'unknown') : undefined,
      entityKind: diagnostic.entityKind,
      entityId: diagnostic.entityId ? safeAtom(diagnostic.entityId, 'unknown') : undefined,
      schemaVersion: diagnostic.schemaVersion,
      parentId: diagnostic.parentId,
      errorClass: diagnostic.errorClass,
      throwingFunction: diagnostic.throwingFunction,
      errorMessage: diagnostic.errorMessage,
      operation: diagnostic.operation ? safeAtom(diagnostic.operation, 'unknown') : undefined,
      retryable: Boolean(diagnostic.retryable),
    });
  }
}

export interface CloudErrorPresentation {
  code: CloudErrorCode;
  message: string;
  status: CloudSyncStatus;
  diagnostic: SafeCloudDiagnostic;
}

export function publicCloudMessage(code: CloudErrorCode): string { return PUBLIC_MESSAGES[code]; }

export function presentCloudError(error: unknown, fallbackStage = 'sync'): CloudErrorPresentation {
  if (error instanceof CloudOperationError) return { code: error.code, message: PUBLIC_MESSAGES[error.code], status: statusFor(error.code), diagnostic: error.diagnostic };
  const candidate = error as { name?: string; status?: number; reason?: string; stage?: string; message?: string; workspaceId?: string; entityKind?: SyncEntityKind; entityType?: SyncEntityKind; entityId?: string; operation?: string; schemaVersion?: string | number; parentId?: string | null; errorClass?: string; throwingFunction?: string; errorMessage?: string };
  const name = safeAtom(candidate?.name, 'Error');
  const status = typeof candidate?.status === 'number' ? candidate.status : undefined;
  const internalMessage = String(candidate?.message ?? '');
  let code: CloudErrorCode = 'sync';
  if (name === 'AuthExpiredError' || status === 401) code = 'auth-expired';
  else if (status === 403 && /insufficientPermissions|authError|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(candidate?.reason ?? '')) code = 'auth-expired';
  else if (name === 'RateLimitedError' || status === 429) code = 'rate-limited';
  else if (name === 'ProviderConflictError') code = 'conflict';
  else if (name === 'TypeError' || name === 'AbortError' || name === 'GoogleDriveTimeoutError') code = 'offline';
  else if (/PANVAS_GOOGLE_CLIENT_ID|client[_ ]?id.*not configured/i.test(internalMessage)) code = 'configuration';
  else if (/client_secret|invalid_request|authorization|oauth|sign-in/i.test(internalMessage)) code = 'connection';
  const diagnostic: SafeCloudDiagnostic = {
    provider: 'googledrive',
    workspaceId: candidate?.workspaceId ? safeAtom(candidate.workspaceId, 'unknown') : undefined,
    stage: safeAtom(candidate?.stage, fallbackStage),
    status,
    reason: safeAtom(candidate?.reason ?? name, 'unknown'),
    entityKind: candidate?.entityKind ?? candidate?.entityType,
    entityId: candidate?.entityId ? safeAtom(candidate.entityId, 'unknown') : undefined,
    operation: candidate?.operation ? safeAtom(candidate.operation, 'unknown') : undefined,
    retryable: code === 'offline' || code === 'rate-limited' || status === 408 || Boolean(status && status >= 500),
    ...(candidate?.schemaVersion !== undefined ? { schemaVersion: safeAtom(candidate.schemaVersion, 'unknown') } : {}),
    ...(candidate?.parentId === null ? { parentId: null } : candidate?.parentId ? { parentId: safeAtom(candidate.parentId, 'unknown') } : {}),
    ...(candidate?.errorClass ? { errorClass: safeAtom(candidate.errorClass, 'unknown') } : {}),
    ...(candidate?.throwingFunction ? { throwingFunction: safeAtom(candidate.throwingFunction, 'unknown') } : {}),
    ...(candidate?.errorMessage ? { errorMessage: safeAtom(candidate.errorMessage, 'unknown') } : {}),
  };
  return { code, message: PUBLIC_MESSAGES[code], status: statusFor(code), diagnostic };
}

export interface CloudApplyFailureContext {
  workspaceId: string;
  entityKind: SyncEntityKind;
  entityId: string;
  parentId?: string | null;
  schemaVersion?: string | number;
  operation?: string;
  stage?: string;
  throwingFunction?: string;
}

/**
 * Convert an untrusted browser/desktop persistence exception into a stable,
 * non-secret diagnostic. Raw exception messages are deliberately not exposed:
 * JSON payloads can contain note/drawing text and filesystem errors can reveal
 * local paths. The normalized class and message are enough to identify the
 * failure while keeping the UI/log boundary safe.
 */
export function cloudApplyFailure(error: unknown, context: CloudApplyFailureContext): CloudOperationError {
  if (error instanceof CloudOperationError) {
    return new CloudOperationError(error.code, {
      ...error.diagnostic,
      stage: error.diagnostic.stage || context.stage || 'local-record-apply',
      reason: error.diagnostic.reason,
      workspaceId: error.diagnostic.workspaceId ?? context.workspaceId,
      entityKind: error.diagnostic.entityKind ?? context.entityKind,
      entityId: error.diagnostic.entityId ?? context.entityId,
      parentId: error.diagnostic.parentId ?? context.parentId,
      schemaVersion: error.diagnostic.schemaVersion ?? (context.schemaVersion === undefined ? undefined : String(context.schemaVersion)),
      operation: error.diagnostic.operation ?? context.operation,
      throwingFunction: error.diagnostic.throwingFunction ?? context.throwingFunction,
    });
  }

  const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
  const errorClass = safeAtom(candidate?.name, 'Error');
  const rawMessage = String(candidate?.message ?? '').toLowerCase();
  const reason = /workspace root record is missing/.test(rawMessage)
    ? 'remote-workspace-root-missing'
    : /workspace root identity does not match/.test(rawMessage)
      ? 'legacy-workspace-identity-mismatch'
      : /different workspace already uses the destination|workspace destination collision/.test(rawMessage)
        ? 'workspace-destination-collision'
        : /json|unexpected token|unexpected end/.test(rawMessage) || errorClass === 'SyntaxError'
    ? 'invalid-payload'
    : /constraint|dataerror|dataclone|transactioninactive|transaction.*closed|quota/.test(rawMessage) || /constrainterror|dataerror|datacloneerror|transactioninactiveerror/.test(errorClass.toLowerCase())
      ? 'local-storage-write-failed'
      : /parent|relationship|sectionid|notebookid|canvasfileid|workspace root|canonical page/.test(rawMessage)
        ? 'invalid-relationship'
        : /enoent|not found|missing/.test(rawMessage)
          ? 'local-parent-unavailable'
          : 'local-apply-error';
  const errorMessage = reason === 'remote-workspace-root-missing' ? 'Remote workspace root record is missing.'
    : reason === 'legacy-workspace-identity-mismatch' ? 'Remote workspace identity needs legacy reconciliation.'
      : reason === 'workspace-destination-collision' ? 'Workspace destination is already owned by another ID.'
        : reason === 'invalid-payload' ? 'Remote payload could not be decoded.'
    : reason === 'local-storage-write-failed' ? 'Local storage rejected the record.'
      : reason === 'invalid-relationship' ? 'Remote record has an invalid relationship.'
        : reason === 'local-parent-unavailable' ? 'Required local parent is unavailable.'
          : 'Local record application failed.';
  const stack = typeof candidate?.stack === 'string' ? candidate.stack : '';
  const throwingFunction = stack.match(/\bat\s+(?:async\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/)?.[1] ?? undefined;
  return new CloudOperationError('payload', {
    stage: context.stage ?? 'local-record-apply',
    reason,
    operation: context.operation ?? 'apply',
    workspaceId: context.workspaceId,
    entityKind: context.entityKind,
    entityId: context.entityId,
    parentId: context.parentId,
    schemaVersion: context.schemaVersion === undefined ? undefined : String(context.schemaVersion),
    errorClass,
    throwingFunction: throwingFunction ?? context.throwingFunction,
    errorMessage,
    retryable: false,
  });
}

function statusFor(code: CloudErrorCode): CloudSyncStatus {
  if (code === 'offline') return 'offline';
  if (code === 'auth-expired') return 'auth-expired';
  if (code === 'rate-limited') return 'rate-limited';
  if (code === 'conflict' || code === 'remote-account-conflict') return 'conflict';
  if (code === 'review' || code === 'cloud-not-initialized') return 'synced-review';
  if (code === 'account-migration-required') return 'account-migration-required';
  return 'error';
}

export function logCloudDiagnostic(diagnostic: SafeCloudDiagnostic): void {
  const safe = sanitizeCloudDiagnostic(diagnostic);
  const diagnosticBridge = (globalThis as typeof globalThis & { window?: { panvas?: { cloudsync?: { logDiagnostic?: (value: SafeCloudDiagnostic) => void } } } }).window?.panvas?.cloudsync?.logDiagnostic;
  if (diagnosticBridge) {
    diagnosticBridge(safe);
    return;
  }
  console.warn('[CloudSync diagnostic]', safe);
}
