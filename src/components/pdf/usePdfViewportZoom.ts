import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { ViewportManager } from '@/components/notebook/engine/ViewportManager';
import type { ViewportTouchPoint } from '@/components/notebook/engine/touchViewportGesture';

interface PageAnchor {
  element: HTMLElement;
  x: number;
  y: number;
}

/** Zoom the visible layout once per frame, then correct its real page anchor
 * before paint. Fixed gaps, centering and scroll padding stay in CSS pixels. */
export function usePdfViewportZoom(
  viewport: ViewportManager,
  scrollRef: RefObject<HTMLDivElement>,
  pagesRef: RefObject<Map<number, HTMLDivElement>>,
  activePage: number,
) {
  const activeRef = useRef(activePage);
  activeRef.current = activePage;
  const frame = useRef<number | null>(null);
  const lastZoom = useRef(-Infinity);
  const pending = useRef<{ scale: number; center?: ViewportTouchPoint; anchor?: PageAnchor } | null>(null);

  const captureAnchor = useCallback((center: ViewportTouchPoint): PageAnchor | undefined => {
    let element = pagesRef.current?.get(activeRef.current);
    for (const candidate of pagesRef.current?.values() ?? []) {
      const bounds = candidate.getBoundingClientRect();
      if (center.x >= bounds.left && center.x <= bounds.right && center.y >= bounds.top && center.y <= bounds.bottom) {
        return { element: candidate, x: (center.x - bounds.left) / bounds.width, y: (center.y - bounds.top) / bounds.height };
      }
    }
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    return { element, x: (center.x - bounds.left) / bounds.width, y: (center.y - bounds.top) / bounds.height };
  }, [pagesRef]);

  const setZoom = useCallback((scale: number, center?: ViewportTouchPoint, anchor?: PageAnchor) => {
    lastZoom.current = performance.now();
    pending.current = { scale: Math.max(0.25, Math.min(4, scale)), center, anchor };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const next = pending.current;
      pending.current = null;
      if (!next) return;
      const scroller = scrollRef.current;
      const bounds = scroller?.getBoundingClientRect();
      const point = next.center ?? (bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : undefined);
      const pageAnchor = next.anchor ?? (point ? captureAnchor(point) : undefined);
      if (next.scale !== viewport.getState().scale) {
        flushSync(() => viewport.setZoom(next.scale));
      }
      if (scroller && point && pageAnchor?.element.isConnected) {
        const after = pageAnchor.element.getBoundingClientRect();
        scroller.scrollLeft += after.left + pageAnchor.x * after.width - point.x;
        scroller.scrollTop += after.top + pageAnchor.y * after.height - point.y;
      }
    });
  }, [captureAnchor, scrollRef, viewport]);

  const getScale = useCallback(() => pending.current?.scale ?? viewport.getState().scale, [viewport]);
  const isZooming = useCallback(() => frame.current !== null || performance.now() - lastZoom.current < 180, []);
  const captureTouchAnchor = useCallback((center: ViewportTouchPoint) => {
    const anchor = captureAnchor(center);
    return (scale: number, nextCenter: ViewportTouchPoint) => setZoom(scale, nextCenter, anchor);
  }, [captureAnchor, setZoom]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
  }, [viewport]);

  return { setZoom, getScale, isZooming, captureTouchAnchor };
}
