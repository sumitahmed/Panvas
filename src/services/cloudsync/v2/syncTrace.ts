import type { SafeCloudDiagnostic } from '../types.ts';

/**
 * Local-development-only synchronization trace. Events carry only
 * allowlisted, already-sanitized fields — never tokens, emails, payloads,
 * filenames or raw exception text — so a trace can be shared without
 * exposing account or document data. Disabled outside Vite dev builds;
 * silent in plain Node test runs.
 */
const enabled = (): boolean => (import.meta.env?.DEV) === true;

export type SyncTraceRuntime = 'desktop' | 'web' | 'unknown';
export type SyncTraceOperation = 'auto' | 'device' | 'cloud' | 'both' | 'mixed' | 'none';

interface SyncTraceRun {
  runtime: SyncTraceRuntime;
  operation: SyncTraceOperation;
  startedAt: number;
}

const activeRuns = new Map<string, SyncTraceRun>();

/** Workspace IDs are stable identifiers, not secrets, but traces stay
 * anonymized anyway: enough to correlate stages, not enough to join data. */
export function anonymizeWorkspaceId(workspaceId: string | null | undefined): string | undefined {
  if (!workspaceId) return undefined;
  if (workspaceId.length <= 8) return `${workspaceId.slice(0, 3)}…`;
  return `${workspaceId.slice(0, 5)}…${workspaceId.slice(-4)}`;
}

export function beginSyncTrace(runtime: SyncTraceRuntime, operation: SyncTraceOperation, workspaceCount: number): string {
  const runId = Math.random().toString(36).slice(2, 10);
  activeRuns.set(runId, { runtime, operation, startedAt: Date.now() });
  emit({ runId, runtime, operation, workspaceCount, stage: 'run-start' });
  return runId;
}

export function traceSyncStage(runId: string, stage: string, detail: Record<string, string | number | boolean | undefined> = {}): void {
  emit({ runId, stage, ...detail });
}

/** Failures are reported through the sanitized diagnostic contract only:
 * error code, stage, operation and reason class. Raw messages never enter
 * the trace. */
export function traceSyncFailure(runId: string, diagnostic: SafeCloudDiagnostic | undefined, errorCode: string | undefined): void {
  emit({
    runId,
    stage: 'run-failure',
    error: errorCode ?? diagnostic?.provider ?? 'unknown',
    reason: diagnostic?.reason,
    failureStage: diagnostic?.stage,
    failureOperation: diagnostic?.operation,
    workspace: anonymizeWorkspaceId(diagnostic?.workspaceId),
    entityKind: diagnostic?.entityKind,
    retryable: diagnostic?.retryable,
  });
}

export function endSyncTrace(runId: string, status: string, summary: Record<string, string | number | boolean | undefined> = {}): void {
  const run = activeRuns.get(runId);
  emit({ runId, stage: 'run-end', status, durationMs: run ? Date.now() - run.startedAt : undefined, ...summary });
  activeRuns.delete(runId);
}

function emit(event: Record<string, string | number | boolean | undefined>): void {
  if (!enabled()) return;
  try { console.info('[CloudSync trace]', JSON.stringify(event)); } catch { /* tracing must never break syncing */ }
}
