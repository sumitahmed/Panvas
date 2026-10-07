// ============================================
// Panvas — Two-finger viewport gestures
// ============================================
// The notebook and PDF surfaces deliberately use `touch-action: none` so a
// finger does not hand an in-progress drawing or selection gesture to the
// browser. This shared controller restores the expected two-finger viewport
// contract inside those surfaces without changing their data models.

import type { NavigationGestureLifecycle } from './NavigationGestureLifecycle.ts';

export interface ViewportTouchPoint {
  x: number;
  y: number;
}

interface GestureAnchor {
  distance: number;
  scale: number;
  documentX: number;
  documentY: number;
}

export interface TwoFingerViewportResult {
  scale: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface TwoFingerViewportGestureOptions {
  target: HTMLElement;
  getScale: () => number;
  setScale: (scale: number) => void;
  /** Stops a just-started single-finger draw/select gesture when a second finger lands. */
  cancelActivePointerInteraction: () => void;
  minScale?: number;
  maxScale?: number;
  /** Unscaled layout offsets (centering/padding) must not scale with content. */
  getContentOffset?: (scale: number) => ViewportTouchPoint;
  /** Documents with fixed page gaps can retain an actual DOM page anchor. */
  captureContentAnchor?: (center: ViewportTouchPoint) => (scale: number, center: ViewportTouchPoint) => void;
  navigationGestures?: NavigationGestureLifecycle;
  /** Cancel synchronously on tool changes without rebinding pointer listeners. */
  subscribeCancellation?: (cancel: () => void) => () => void;
}

function midpoint(first: ViewportTouchPoint, second: ViewportTouchPoint): ViewportTouchPoint {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance(first: ViewportTouchPoint, second: ViewportTouchPoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Keep the document point beneath the two-finger midpoint stable as it zooms. */
export function resolveTwoFingerViewport({
  anchor,
  currentDistance,
  currentCenter,
  bounds,
  minScale = 0.25,
  maxScale = 4,
  contentOffset = { x: 0, y: 0 },
}: {
  anchor: GestureAnchor;
  currentDistance: number;
  currentCenter: ViewportTouchPoint;
  bounds: Pick<DOMRect, 'left' | 'top'>;
  minScale?: number;
  maxScale?: number;
  contentOffset?: ViewportTouchPoint;
}): TwoFingerViewportResult {
  const ratio = anchor.distance > 0 ? currentDistance / anchor.distance : 1;
  const scale = clamp(anchor.scale * ratio, minScale, maxScale);
  return {
    scale,
    scrollLeft: anchor.documentX * scale + contentOffset.x - (currentCenter.x - bounds.left),
    scrollTop: anchor.documentY * scale + contentOffset.y - (currentCenter.y - bounds.top),
  };
}

/**
 * Attach two-finger pan/pinch to a scroll viewport. Capture-phase listeners
 * run before the page canvas input manager, letting a second finger promote an
 * in-progress one-finger edit into a pure viewport gesture.
 */
export function attachTwoFingerViewportGesture({
  target,
  getScale,
  setScale,
  cancelActivePointerInteraction,
  minScale = 0.25,
  maxScale = 4,
  getContentOffset = () => ({ x: 0, y: 0 }),
  captureContentAnchor,
  navigationGestures,
  subscribeCancellation,
}: TwoFingerViewportGestureOptions): () => void {
  const pointers = new Map<number, ViewportTouchPoint>();
  let anchor: GestureAnchor | null = null;
  let pendingPosition: TwoFingerViewportResult | null = null;
  let frame: number | null = null;
  let suppressUntilAllLifted = false;
  let releaseNavigation: (() => void) | null = null;
  let applyContentAnchor: ReturnType<NonNullable<TwoFingerViewportGestureOptions['captureContentAnchor']>> | null = null;

  const twoPointers = (): [ViewportTouchPoint, ViewportTouchPoint] | null => {
    const points = [...pointers.values()];
    return points.length >= 2 ? [points[0], points[1]] : null;
  };

  const applyPendingPosition = () => {
    frame = null;
    if (!pendingPosition) return;
    const next = pendingPosition;
    pendingPosition = null;
    // The owner commits its scaled layout before we correct scroll. Applying
    // scroll against the old layout clamps it, then jumps on the next frame.
    setScale(next.scale);
    target.scrollLeft = next.scrollLeft;
    target.scrollTop = next.scrollTop;
  };

  const schedulePosition = (next: TwoFingerViewportResult) => {
    pendingPosition = next;
    if (frame === null && typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(applyPendingPosition);
    } else if (typeof requestAnimationFrame !== 'function') applyPendingPosition();
  };

  const begin = () => {
    const pair = twoPointers();
    if (!pair) return;
    const bounds = target.getBoundingClientRect();
    const center = midpoint(pair[0], pair[1]);
    applyContentAnchor = captureContentAnchor?.(center) ?? null;
    const scale = getScale();
    const offset = getContentOffset(scale);
    anchor = {
      distance: Math.max(1, distance(pair[0], pair[1])),
      scale,
      documentX: (target.scrollLeft + center.x - bounds.left - offset.x) / scale,
      documentY: (target.scrollTop + center.y - bounds.top - offset.y) / scale,
    };
    // Hold the promoted owner BEFORE canceling the canvas owner, so idle/page
    // handoff can never run between one-finger and two-finger navigation.
    releaseNavigation ??= navigationGestures?.begin() ?? null;
    suppressUntilAllLifted = true;
    cancelActivePointerInteraction();
    for (const id of pointers.keys()) {
      try { target.setPointerCapture(id); } catch { /* Synthetic events have no native capture. */ }
    }
  };

  const update = () => {
    const pair = twoPointers();
    if (!anchor || !pair) return;
    const next = resolveTwoFingerViewport({
      anchor,
      currentDistance: distance(pair[0], pair[1]),
      currentCenter: midpoint(pair[0], pair[1]),
      bounds: target.getBoundingClientRect(),
      minScale,
      maxScale,
      contentOffset: getContentOffset(clamp(anchor.scale * distance(pair[0], pair[1]) / anchor.distance, minScale, maxScale)),
    });
    if (applyContentAnchor) applyContentAnchor(next.scale, midpoint(pair[0], pair[1]));
    else {
      schedulePosition(next);
    }
  };

  const record = (event: PointerEvent) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  const isTouch = (event: PointerEvent) => event.pointerType === 'touch';

  const onPointerDown = (event: PointerEvent) => {
    if (!isTouch(event)) return;
    record(event);
    if (pointers.size < 2) return;
    event.preventDefault();
    event.stopPropagation();
    if (!anchor) begin();
    else {
      try { target.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer. */ }
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!isTouch(event) || !pointers.has(event.pointerId)) return;
    record(event);
    if (!anchor && !suppressUntilAllLifted) return;
    event.preventDefault();
    event.stopPropagation();
    update();
  };

  const reset = (applyFinalPosition = false) => {
    if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = null;
    if (applyFinalPosition) applyPendingPosition();
    pendingPosition = null;
    const capturedIds = [...pointers.keys()];
    pointers.clear();
    anchor = null;
    applyContentAnchor = null;
    suppressUntilAllLifted = false;
    const release = releaseNavigation;
    releaseNavigation = null;
    for (const id of capturedIds) {
      try {
        if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
      } catch { /* Capture already lost. */ }
    }
    release?.();
  };

  const cancel = () => reset();
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') cancel();
  };
  const onLostPointerCapture = (event: PointerEvent) => {
    // Canvas capture loss during promotion bubbles here; the viewport owner
    // remains authoritative. Only loss of our own capture cancels navigation.
    if (!pointers.has(event.pointerId)) return;
    if (suppressUntilAllLifted) {
      if (event.target === target) cancel();
    } else {
      // An independently owned one-finger pan may lose capture and finish
      // outside this viewport. Do not treat its stale ID as a second finger.
      pointers.delete(event.pointerId);
    }
  };

  const finishPointer = (event: PointerEvent) => {
    if (!isTouch(event) || !pointers.has(event.pointerId)) return;
    const wasGesture = suppressUntilAllLifted;
    pointers.delete(event.pointerId);
    if (wasGesture) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.type === 'pointercancel') {
      cancel();
      return;
    }
    if (pointers.size < 2) anchor = null;
    // Keep ownership while the remaining finger is still suppressed, even
    // though no more two-finger movement is possible.
    if (pointers.size === 0) reset(true);
  };

  target.addEventListener('pointerdown', onPointerDown, { capture: true });
  target.addEventListener('pointermove', onPointerMove, { capture: true });
  target.addEventListener('pointerup', finishPointer, { capture: true });
  target.addEventListener('pointercancel', finishPointer, { capture: true });
  target.addEventListener('lostpointercapture', onLostPointerCapture, { capture: true });
  window.addEventListener('blur', cancel);
  window.addEventListener('pointerup', finishPointer, { capture: true });
  window.addEventListener('pointercancel', finishPointer, { capture: true });
  window.addEventListener('lostpointercapture', onLostPointerCapture, { capture: true });
  document.addEventListener('visibilitychange', onVisibilityChange);
  const unsubscribeCancellation = subscribeCancellation?.(cancel);

  return () => {
    target.removeEventListener('pointerdown', onPointerDown, { capture: true });
    target.removeEventListener('pointermove', onPointerMove, { capture: true });
    target.removeEventListener('pointerup', finishPointer, { capture: true });
    target.removeEventListener('pointercancel', finishPointer, { capture: true });
    target.removeEventListener('lostpointercapture', onLostPointerCapture, { capture: true });
    window.removeEventListener('blur', cancel);
    window.removeEventListener('pointerup', finishPointer, { capture: true });
    window.removeEventListener('pointercancel', finishPointer, { capture: true });
    window.removeEventListener('lostpointercapture', onLostPointerCapture, { capture: true });
    document.removeEventListener('visibilitychange', onVisibilityChange);
    unsubscribeCancellation?.();
    cancel();
  };
}
