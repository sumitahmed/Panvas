/**
 * Tracks renderer-side interactive gestures (drawing, scroll/zoom navigation,
 * selection/lasso drags, and text typing) so background Cloud Sync never
 * competes with active 60-120 fps user interaction. Independent of local
 * saves and retries.
 *
 * Owners are object identities rather than a single boolean so an unmounting
 * renderer cannot clear another renderer's active gesture.
 */
const DRAWING_COOLDOWN_MS = 2_500;
const NAVIGATION_COOLDOWN_MS = 1_000;
const SELECTION_COOLDOWN_MS = 1_000;
const TYPING_COOLDOWN_MS = 1_000;

const activeOwners = new Set<object>();
let lastActivityAt = 0;

const activeNavigationOwners = new Set<object>();
let lastNavigationAt = 0;

const activeSelectionOwners = new Set<object>();
let lastSelectionAt = 0;

let lastTypingAt = 0;

const idleListeners = new Set<() => void>();

function notifyListeners(): void {
  if (idleListeners.size === 0) return;
  for (const listener of [...idleListeners]) {
    listener();
  }
}

export function setDrawingGestureActive(owner: object, active: boolean, now = Date.now()): void {
  if (active) activeOwners.add(owner);
  else activeOwners.delete(owner);
  lastActivityAt = now;
  notifyListeners();
}

export function setNavigationGestureActive(owner: object, active: boolean, now = Date.now()): void {
  if (active) activeNavigationOwners.add(owner);
  else activeNavigationOwners.delete(owner);
  lastNavigationAt = now;
  notifyListeners();
}

export function markNavigationActivity(now = Date.now()): void {
  lastNavigationAt = now;
  notifyListeners();
}

export function setSelectionGestureActive(owner: object, active: boolean, now = Date.now()): void {
  if (active) activeSelectionOwners.add(owner);
  else activeSelectionOwners.delete(owner);
  lastSelectionAt = now;
  notifyListeners();
}

export function markTextTypingActivity(now = Date.now()): void {
  lastTypingAt = now;
  notifyListeners();
}

export function isDrawingActive(): boolean {
  return activeOwners.size > 0;
}

/** True during contact and for `idleMs` after the last contact boundary. */
export function isDrawingRecentlyActive(idleMs: number, now = Date.now()): boolean {
  return activeOwners.size > 0 || now - lastActivityAt < idleMs;
}

/** True while any drawing, scroll/zoom, selection drag, or typing gesture is active or cooling down. */
export function isUserInteracting(now = Date.now()): boolean {
  if (activeOwners.size > 0 || activeNavigationOwners.size > 0 || activeSelectionOwners.size > 0) {
    return true;
  }
  return (
    now - lastActivityAt < DRAWING_COOLDOWN_MS
    || now - lastNavigationAt < NAVIGATION_COOLDOWN_MS
    || now - lastSelectionAt < SELECTION_COOLDOWN_MS
    || now - lastTypingAt < TYPING_COOLDOWN_MS
  );
}

function nextIdleWaitMs(now = Date.now(), drawingOnly = false): number {
  if (drawingOnly) {
    if (activeOwners.size > 0 || activeNavigationOwners.size > 0 || activeSelectionOwners.size > 0) return 50;
    return 0;
  }
  if (activeOwners.size > 0 || activeNavigationOwners.size > 0 || activeSelectionOwners.size > 0) {
    return 50;
  }
  let wait = 0;
  const check = (last: number, cooldown: number) => {
    const remaining = cooldown - (now - last);
    if (remaining > wait) wait = remaining;
  };
  check(lastActivityAt, DRAWING_COOLDOWN_MS);
  check(lastNavigationAt, NAVIGATION_COOLDOWN_MS);
  check(lastSelectionAt, SELECTION_COOLDOWN_MS);
  check(lastTypingAt, TYPING_COOLDOWN_MS);
  return Math.max(0, Math.ceil(wait));
}

export function waitUntilUserIdle(
  signal?: AbortSignal,
  options?: { drawingOnly?: boolean },
): Promise<void> {
  const drawingOnly = options?.drawingOnly === true;
  const initialWait = nextIdleWaitMs(Date.now(), drawingOnly);
  if (initialWait === 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Aborted'));
  }

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      idleListeners.delete(evaluate);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const evaluate = () => {
      const wait = nextIdleWaitMs(Date.now(), drawingOnly);
      if (wait === 0) {
        cleanup();
        resolve();
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(evaluate, wait);
    };
    idleListeners.add(evaluate);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(evaluate, initialWait);
  });
}

let sharedChannel: MessageChannel | null = null;
const channelQueue: Array<() => void> = [];

/** Yield cleanly to the next task/frame so interactive input can process without 16ms throttling. */
export function yieldToMainThread(): Promise<void> {
  if (typeof MessageChannel !== 'undefined' && typeof window !== 'undefined') {
    if (!sharedChannel) {
      sharedChannel = new MessageChannel();
      sharedChannel.port1.onmessage = () => {
        const next = channelQueue.shift();
        if (next) next();
      };
    }
    return new Promise<void>(resolve => {
      channelQueue.push(resolve);
      sharedChannel!.port2.postMessage(null);
    });
  }
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

export interface SyncTimeSlicer {
  checkpoint(): Promise<void>;
  shouldYield(): boolean;
}

const nowHighRes = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

/**
 * Cooperative time slicer for background Cloud Sync CPU & I/O loops.
 * Keeps individual main-thread slices <= `budgetMs` (default 4 ms) and pauses
 * cleanly whenever the user draws, scrolls, zooms, drags a selection, or types.
 */
export function createSyncTimeSlicer(options: {
  budgetMs?: number;
  pauseOnInteraction?: boolean;
  signal?: AbortSignal;
} = {}): SyncTimeSlicer {
  const budgetMs = options.budgetMs ?? 3;
  const pauseOnInteraction = options.pauseOnInteraction !== false;
  const signal = options.signal;
  let sliceStart = nowHighRes();

  const isInputPending = (): boolean => {
    try {
      const nav = typeof navigator !== 'undefined' ? (navigator as unknown as {
        scheduling?: { isInputPending?: (opts?: { includeContinuous?: boolean }) => boolean };
      }) : undefined;
      return Boolean(nav?.scheduling?.isInputPending?.({ includeContinuous: true }));
    } catch {
      return false;
    }
  };

  return {
    shouldYield(): boolean {
      if (pauseOnInteraction && isUserInteracting()) return true;
      if (!pauseOnInteraction && (isDrawingActive() || activeNavigationOwners.size > 0 || activeSelectionOwners.size > 0)) return true;
      return nowHighRes() - sliceStart >= budgetMs || isInputPending();
    },
    async checkpoint(): Promise<void> {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('Sync aborted');
      }
      if (pauseOnInteraction && isUserInteracting()) {
        await waitUntilUserIdle(signal);
        sliceStart = nowHighRes();
        return;
      }
      if (!pauseOnInteraction && (isDrawingActive() || activeNavigationOwners.size > 0 || activeSelectionOwners.size > 0)) {
        await waitUntilUserIdle(signal, { drawingOnly: true });
        sliceStart = nowHighRes();
        return;
      }
      if (nowHighRes() - sliceStart >= budgetMs || isInputPending()) {
        await yieldToMainThread();
        if (signal?.aborted) {
          throw signal.reason ?? new Error('Sync aborted');
        }
        if (pauseOnInteraction && isUserInteracting()) {
          await waitUntilUserIdle(signal);
        } else if (!pauseOnInteraction && (isDrawingActive() || activeNavigationOwners.size > 0 || activeSelectionOwners.size > 0)) {
          await waitUntilUserIdle(signal, { drawingOnly: true });
        }
        sliceStart = nowHighRes();
      }
    },
  };
}

export function resetDrawingActivityForTests(): void {
  activeOwners.clear();
  activeNavigationOwners.clear();
  activeSelectionOwners.clear();
  lastActivityAt = 0;
  lastNavigationAt = 0;
  lastSelectionAt = 0;
  lastTypingAt = 0;
  notifyListeners();
}
