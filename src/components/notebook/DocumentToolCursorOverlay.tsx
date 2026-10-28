import React, { useEffect, useRef } from 'react';
import type { ToolState } from './engine/drawingTypes.ts';
import {
  computeCursorTransform,
  isInteractiveUIElement,
  isPointInsideElement,
  resolveToolCursorDescriptor,
  shouldShowPenCursor,
  StylusCursorOverlayController,
  type ToolCursorDescriptor,
} from './documentToolCursor.ts';

export {
  computeCursorTransform,
  isInteractiveUIElement,
  isPointInsideElement,
  shouldShowPenCursor,
  StylusCursorOverlayController,
};

export interface DocumentToolCursorOverlayProps {
  toolState: ToolState;
  containerRef: React.RefObject<HTMLElement | null>;
}

export const DocumentToolCursorOverlay: React.FC<DocumentToolCursorOverlayProps> = ({
  toolState,
  containerRef,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const descriptor = resolveToolCursorDescriptor(toolState);
  const descriptorRef = useRef<ToolCursorDescriptor | undefined>(descriptor);
  descriptorRef.current = descriptor;

  const controllerRef = useRef<StylusCursorOverlayController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = new StylusCursorOverlayController({
      getDescriptor: () => descriptorRef.current,
      getContainer: () => containerRef.current,
      onVisibilityChange: visible => {
        if (overlayRef.current) {
          overlayRef.current.style.display = visible ? 'block' : 'none';
        }
      },
      onPositionChange: transform => {
        if (overlayRef.current) {
          overlayRef.current.style.transform = transform;
        }
      },
      onStylusActiveChange: active => {
        const container = containerRef.current;
        if (container) {
          if (active) {
            container.classList.add('panvas-stylus-canvas-active');
          } else {
            container.classList.remove('panvas-stylus-canvas-active');
          }
        }
      },
    });
  }

  // If descriptor updates (tool switch, color change), notify controller immediately
  useEffect(() => {
    controllerRef.current?.syncDescriptor(descriptor);
  }, [descriptor]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;

    const onPointerMove = (e: PointerEvent) => controller.handlePointerMove(e);
    const onPointerDown = (e: PointerEvent) => controller.handlePointerDown(e);
    const onPointerUp = (e: PointerEvent) => controller.handlePointerUp(e);
    const onPointerCancel = (e: PointerEvent) => controller.handlePointerCancel(e);
    const onBlur = () => controller.handleBlur();

    const onContainerEnter = (e: PointerEvent) => controller.handleContainerPointerEnter(e);
    const onContainerLeave = (e: PointerEvent) => controller.handleContainerPointerLeave(e);

    // Attach to window using capture phase to guarantee interception even under pointer capture
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    window.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { capture: true, passive: true });
    window.addEventListener('blur', onBlur);

    const hasRawUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window;
    if (hasRawUpdate) {
      window.addEventListener('pointerrawupdate' as any, onPointerMove, { capture: true, passive: true });
    }

    const container = containerRef.current;
    if (container) {
      container.addEventListener('pointerenter', onContainerEnter);
      container.addEventListener('pointerleave', onContainerLeave);
    }

    return () => {
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointerup', onPointerUp, { capture: true });
      window.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      window.removeEventListener('blur', onBlur);
      if (hasRawUpdate) {
        window.removeEventListener('pointerrawupdate' as any, onPointerMove, { capture: true });
      }
      if (container) {
        container.removeEventListener('pointerenter', onContainerEnter);
        container.removeEventListener('pointerleave', onContainerLeave);
        container.classList.remove('panvas-stylus-canvas-active');
      }
      controller.destroy();
    };
  }, [containerRef]);

  return (
    <div
      ref={overlayRef}
      data-testid="document-tool-cursor-overlay"
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 99999,
        display: 'none',
        willChange: 'transform',
        transform: 'translate3d(-1000px, -1000px, 0)',
        transition: 'none',
      }}
    >
      {descriptor ? (
        <div
          data-testid="document-tool-cursor-svg"
          dangerouslySetInnerHTML={{ __html: descriptor.svg }}
          style={{
            width: descriptor.width,
            height: descriptor.height,
            display: 'block',
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </div>
  );
};
