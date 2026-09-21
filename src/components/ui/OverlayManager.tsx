import React, { useEffect, useState, useRef } from 'react';
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
  const [position, setPosition] = useState({ top: -9999, left: -9999 });

  useEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const anchor = anchorRef.current;
      const overlay = overlayRef.current;
      if (!anchor || !overlay) return;
      
      const anchorRect = anchor.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const viewportPadding = 12;

      let top = 0;
      let left = 0;

      const overlayHeight = Math.min(overlayRect.height, viewportHeight - viewportPadding * 2);
      const overlayWidth = Math.min(overlayRect.width, viewportWidth - viewportPadding * 2);
      const spaceBelow = viewportHeight - anchorRect.bottom - offset.y - viewportPadding;
      const spaceAbove = anchorRect.top - offset.y - viewportPadding;
      const prefersBottom = placement.startsWith('bottom');
      const shouldOpenBelow = prefersBottom
        ? spaceBelow >= overlayHeight || spaceBelow >= spaceAbove
        : !(spaceAbove >= overlayHeight || spaceAbove > spaceBelow);

      // Choose the side with enough room where possible. For panels taller
      // than either side, prefer the larger side and clamp them to the
      // viewport. This prevents settings panels from flipping above the page
      // and becoming inaccessible when opened near the top of a document.
      if (shouldOpenBelow) {
        top = anchorRect.bottom + offset.y;
      } else {
        top = anchorRect.top - overlayRect.height - offset.y;
      }
      top = Math.max(viewportPadding, Math.min(top, viewportHeight - overlayHeight - viewportPadding));

      // Horizontal placement
      if (placement.endsWith('start')) {
        left = anchorRect.left + offset.x;
      } else {
        left = anchorRect.right - overlayRect.width + offset.x;
      }
      left = Math.max(viewportPadding, Math.min(left, viewportWidth - overlayWidth - viewportPadding));

      setPosition({ top, left });
    };

    // Need a micro-delay for first render dimensions
    requestAnimationFrame(updatePosition);
    const resizeObserver = new ResizeObserver(updatePosition);
    if (overlayRef.current) resizeObserver.observe(overlayRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      resizeObserver.disconnect();
    };
  }, [isOpen, anchorRef, placement, offset.x, offset.y]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        overlayRef.current &&
        !overlayRef.current.contains(e.target as Node) &&
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
  }, [isOpen, onClose, anchorRef]);

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className={`panvas-overlay fixed overflow-auto ${shouldUseSheet ? 'panvas-mobile-sheet' : ''}`}
      style={shouldUseSheet ? { bottom: 'var(--panvas-keyboard-inset, 0px)' } : {
        top: position.top,
        left: position.left,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'calc(100vh - 24px)',
        visibility: position.top === -9999 ? 'hidden' : 'visible',
        zIndex: 60,
      }}
    >
      {shouldUseSheet && <button type="button" onClick={onClose} className="panvas-sheet-close" aria-label="Close panel">Done</button>}
      {children}
    </div>,
    document.body
  );
}
