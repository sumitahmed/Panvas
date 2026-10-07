import React, { createContext, useContext, useEffect, useId, useLayoutEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport';

interface OverlayManagerProps {
  children: React.ReactNode;
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  offset?: { x: number; y: number };
  asSheet?: boolean;
}

const ParentOverlayContext = createContext<string | null>(null);

function isInOverlay(target: EventTarget | null, overlayId: string): boolean {
  let overlay = target instanceof Element ? target.closest<HTMLElement>('[data-panvas-overlay-id]') : null;
  while (overlay) {
    if (overlay.dataset.panvasOverlayId === overlayId) return true;
    const parentId = overlay.dataset.panvasOverlayParent;
    overlay = parentId ? document.querySelector<HTMLElement>(`[data-panvas-overlay-id="${CSS.escape(parentId)}"]`) : null;
  }
  return false;
}

export function OverlayManager({ 
  children, 
  isOpen, 
  onClose, 
  anchorRef, 
  placement = 'bottom-start',
  offset = { x: 0, y: 4 },
  asSheet = false
}: OverlayManagerProps) {
  const isPhone = useIsMobileViewport();
  const shouldUseSheet = isPhone && asSheet;
  const overlayRef = useRef<HTMLDivElement>(null);
  const overlayId = useId();
  const parentOverlayId = useContext(ParentOverlayContext);
  const [position, setPosition] = useState({ top: -9999, left: -9999, maxWidth: 0, maxHeight: 0 });

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const anchor = anchorRef.current;
      const overlay = overlayRef.current;
      if (!anchor || !overlay) return;
      
      const anchorRect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportPadding = 12;
      const safeStyle = getComputedStyle(overlay);
      const safe = (edge: string) => parseFloat(safeStyle.getPropertyValue(`--panvas-overlay-safe-${edge}`)) || 0;
      const viewportLeft = (viewport?.offsetLeft ?? 0) + safe('left') + viewportPadding;
      const viewportTop = (viewport?.offsetTop ?? 0) + safe('top') + viewportPadding;
      const viewportRight = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - safe('right') - viewportPadding;
      let viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - safe('bottom') - viewportPadding;
      const dock = document.querySelector<HTMLElement>('.panvas-mobile-tool-dock');
      if (dock && dock.getBoundingClientRect().height > 0) viewportBottom = Math.min(viewportBottom, dock.getBoundingClientRect().top - 8);
      const maxWidth = Math.max(0, viewportRight - viewportLeft);
      overlay.style.maxWidth = `${maxWidth}px`;
      const overlayRect = overlay.getBoundingClientRect();
      const content = overlay.firstElementChild as HTMLElement | null;
      const naturalHeight = Math.max(overlay.scrollHeight, content ? content.scrollHeight + content.offsetHeight - content.clientHeight : 0);
      const anchorTop = Math.max(viewportTop, Math.min(anchorRect.top, viewportBottom));
      const anchorBottom = Math.max(viewportTop, Math.min(anchorRect.bottom, viewportBottom));
      const spaceBelow = Math.max(0, viewportBottom - anchorBottom - offset.y);
      const spaceAbove = Math.max(0, anchorTop - offset.y - viewportTop);
      const prefersBottom = placement.startsWith('bottom');
      const shouldOpenBelow = prefersBottom
        ? spaceBelow >= naturalHeight || spaceBelow >= spaceAbove
        : !(spaceAbove >= naturalHeight || spaceAbove > spaceBelow);
      const maxHeight = shouldUseSheet ? Math.max(0, viewportBottom - viewportTop) : shouldOpenBelow ? spaceBelow : spaceAbove;
      // Constrain the rendered panel itself before positioning it. Clamping
      // only the positioning math leaves tall children behind the tool dock.
      overlay.style.maxHeight = `${maxHeight}px`;
      overlay.style.setProperty('--panvas-overlay-max-height', `${maxHeight}px`);
      const overlayHeight = overlay.getBoundingClientRect().height;
      const top = shouldUseSheet ? viewportBottom - overlayHeight : shouldOpenBelow ? anchorBottom + offset.y : anchorTop - overlayHeight - offset.y;

      // Horizontal placement
      const preferredLeft = placement.endsWith('start') ? anchorRect.left + offset.x : anchorRect.right - overlayRect.width + offset.x;
      const left = Math.max(viewportLeft, Math.min(preferredLeft, viewportRight - overlayRect.width));
      setPosition(previous => previous.top === top && previous.left === left && previous.maxWidth === maxWidth && previous.maxHeight === maxHeight ? previous : { top, left, maxWidth, maxHeight });
    };

    updatePosition();
    const resizeObserver = new ResizeObserver(updatePosition);
    if (overlayRef.current) resizeObserver.observe(overlayRef.current);
    if (anchorRef.current) resizeObserver.observe(anchorRef.current);
    const dock = document.querySelector('.panvas-mobile-tool-dock');
    if (dock) resizeObserver.observe(dock);
    const onScroll = (event: Event) => {
      // Internal menu scrolling must not reposition its own panel.
      if (event.target instanceof Node && overlayRef.current?.contains(event.target)) return;
      updatePosition();
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('scroll', updatePosition);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('scroll', updatePosition);
      resizeObserver.disconnect();
    };
  }, [isOpen, anchorRef, placement, offset.x, offset.y, shouldUseSheet]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        overlayRef.current &&
        !overlayRef.current.contains(e.target as Node) &&
        !isInOverlay(e.target, overlayId) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, anchorRef, overlayId]);

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={overlayRef}
      data-panvas-overlay-id={overlayId}
      data-panvas-overlay-parent={parentOverlayId ?? undefined}
      className={`panvas-overlay panvas-anchored-overlay fixed overflow-auto overscroll-contain ${shouldUseSheet ? 'panvas-mobile-sheet' : ''}`}
      style={{
        top: position.top,
        left: position.left,
        bottom: 'auto',
        maxWidth: position.top === -9999 ? 'calc(100dvw - 24px)' : position.maxWidth,
        maxHeight: position.top === -9999 ? 'calc(100dvh - 24px)' : position.maxHeight,
        visibility: position.top === -9999 ? 'hidden' : 'visible',
        zIndex: 60,
      }}
    >
      <ParentOverlayContext.Provider value={overlayId}>
        {shouldUseSheet && <button type="button" onClick={onClose} className="panvas-sheet-close" aria-label="Close panel">Done</button>}
        {children}
      </ParentOverlayContext.Provider>
    </div>,
    document.body
  );
}
