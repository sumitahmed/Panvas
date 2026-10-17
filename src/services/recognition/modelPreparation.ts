/**
 * Background local-model preparation.
 *
 * 2026-08-29: the runtime fallback is DISABLED (TrOCR-small rejected for
 * user-verified accuracy failure), so preparation is dormant — this module
 * exists so the eventual UX contract is fixed and tested now:
 *
 *   Panvas starts → app usable immediately → native provider capability
 *   checked → if unavailable, model preparation begins at an idle moment in
 *   the background → restrained status → once cached, zero network on later
 *   starts. Preparation never blocks startup and never waits for the first
 *   handwritten phrase.
 */

import { LOCAL_NEURAL_FALLBACK_ENABLED } from './index.ts';
import { LOCAL_HANDWRITING_MODEL_REVISION } from './neural/neuralWorkerProtocol.ts';
import { NEURAL_STATUS_EVENT, type NeuralStatusDetail } from './providers/LocalNeuralHandwritingRecognitionProvider.ts';

export type ModelPreparationState = 'disabled' | 'native-available' | 'preparing' | 'ready' | 'failed';

export interface ModelPreparationStatus {
  state: ModelPreparationState;
  revision: string;
  message?: string;
}

type PreparationListener = (status: ModelPreparationStatus) => void;

const listeners = new Set<PreparationListener>();
let currentStatus: ModelPreparationStatus = { state: 'disabled', revision: LOCAL_HANDWRITING_MODEL_REVISION };
let inflight: Promise<boolean> | null = null;
let deferredKickoffDone = false;

/** Same capability expression as the factory's native-provider check. */
function isNativeHandwritingApiAvailable(): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.createHandwritingRecognizer === 'function'
    && typeof (globalThis as typeof globalThis & { HandwritingStroke?: unknown }).HandwritingStroke === 'function';
}

function setStatus(status: ModelPreparationStatus): void {
  currentStatus = status;
  for (const listener of listeners) listener(status);
  if (typeof document !== 'undefined' && (status.state === 'preparing' || status.state === 'ready')) {
    document.dispatchEvent(new CustomEvent<NeuralStatusDetail>(NEURAL_STATUS_EVENT, {
      detail: {
        state: status.state === 'ready' ? 'ready' : 'preparing',
        message: status.state === 'ready'
          ? 'Offline handwriting recognition is ready.'
          : 'Preparing offline handwriting recognition',
      },
    }));
  }
}

export function getLocalModelPreparationStatus(): ModelPreparationStatus {
  return currentStatus;
}

export function onLocalModelPreparation(listener: PreparationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Decides whether background preparation should run in this environment.
 * Exported (pure) for tests.
 */
export function shouldPrepareLocalModel(input: {
  fallbackEnabled: boolean;
  hasNativeHandwritingApi: boolean;
  hasWindow: boolean;
}): boolean {
  if (!input.hasWindow) return false;
  if (!input.fallbackEnabled) return false;
  return !input.hasNativeHandwritingApi;
}

/**
 * Begins background model preparation once per app run. Resolves true when
 * the model is (or became) locally cached and usable. Never throws.
 */
export function prepareLocalHandwritingModel(options: { reason?: string } = {}): Promise<boolean> {
  if (inflight) return inflight;
  if (!LOCAL_NEURAL_FALLBACK_ENABLED || !shouldPrepareLocalModel({
    fallbackEnabled: LOCAL_NEURAL_FALLBACK_ENABLED,
    hasNativeHandwritingApi: isNativeHandwritingApiAvailable(),
    hasWindow: typeof window !== 'undefined',
  })) {
    const state: ModelPreparationState = isNativeHandwritingApiAvailable() ? 'native-available' : 'disabled';
    if (currentStatus.state !== state) setStatus({ ...currentStatus, state });
    return Promise.resolve(false);
  }
  setStatus({ state: 'preparing', revision: LOCAL_HANDWRITING_MODEL_REVISION, message: options.reason });
  inflight = (async () => {
    try {
      const { LocalNeuralHandwritingRecognitionProvider } = await import('./providers/LocalNeuralHandwritingRecognitionProvider.ts');
      const provider = new LocalNeuralHandwritingRecognitionProvider();
      const available = await provider.isAvailable();
      if (!available) return false;
      setStatus({ state: 'ready', revision: LOCAL_HANDWRITING_MODEL_REVISION });
      return true;
    } catch (error) {
      setStatus({
        state: 'failed',
        revision: LOCAL_HANDWRITING_MODEL_REVISION,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Startup hook: defers preparation until the app has clearly settled so it
 * never competes with first paint or the restore pass.
 */
export function scheduleDeferredLocalModelPreparation(delayMs = 5_000): void {
  if (deferredKickoffDone || typeof window === 'undefined') return;
  deferredKickoffDone = true;
  const kickoff = () => { void prepareLocalHandwritingModel({ reason: 'startup-idle' }); };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => window.setTimeout(kickoff, delayMs));
  } else {
    window.setTimeout(kickoff, delayMs + 2_000);
  }
}
