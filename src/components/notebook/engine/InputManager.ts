// ============================================
// Panvas — Input Manager
// ============================================
// Handles pointer events on the drawing canvas and routes them
// to the appropriate engine module based on the active tool.
// No React dependency — attaches directly to DOM elements.

import type { StrokePoint, DrawingToolId, Shape, Stroke, NotebookMode } from './drawingTypes';
import { resolveDrawingStrokeContext, type DrawingStrokeContext, type ToolManager } from './ToolManager.ts';
import type { ViewportManager } from './ViewportManager';
import type { DrawingEngine } from './DrawingEngine';
import type { EraserEngine } from './EraserEngine';
import { analyzeScribble, findScribbleTargets } from './scribbleGesture.ts';
import { analyzeCircleGesture } from './circleSelectGesture.ts';
import { recognizeStraightLine } from './straightLineGesture.ts';
import { recognizeRoughShape } from './roughShapeGesture.ts';
import type { ShapeManager } from './ShapeManager';
import type { SelectionEngine } from './SelectionEngine';
import type { HistoryManager } from './HistoryManager';
import type { TextManager } from './TextManager';
import { generateId } from '../../../lib/utils/id.ts';
import { constrainShapeDrag } from './shapeGeometry.ts';
import type { RulerHit, RulerManager } from './RulerManager.ts';
import type { LaserManager } from './LaserManager.ts';
import { InkInputFilter, mapPointerPressure } from './inkInput.ts';
import { gate0Profiler, type Gate0Record } from '../../../dev/gate0Profiler.ts';
import { EraserGesture } from './EraserGesture.ts';
import { InkSamples } from './inkSamples.ts';
import { startHandwritingTrace, finishHandwritingTrace, type HandwritingTrace } from '../../../dev/handwritingTrace.ts';

export type DrawingChangeListener = () => void;
export type DrawingGestureListener = (active: boolean) => void;
export type InkStrokeLifecycleEvent =
  | { type: 'start'; instrument: 'pen' | 'pencil' }
  | { type: 'cancel'; instrument: 'pen' | 'pencil' }
  | { type: 'complete'; instrument: 'pen' | 'pencil'; stroke: Stroke };

const SELECTION_CURSORS = new Set([
  'default',
  'nwse-resize',
  'nesw-resize',
  'ns-resize',
  'ew-resize',
  'grab',
]);

export class InputManager {
  private toolManager: ToolManager;
  private viewport: ViewportManager;
  private drawingEngine: DrawingEngine;
  private eraserEngine: EraserEngine;
  private shapeManager: ShapeManager;
  private selectionEngine: SelectionEngine;
  private historyManager: HistoryManager;
  private textManager: TextManager;
  private canvas: HTMLCanvasElement | null = null;
  private unsubscribeToolState: (() => void) | null = null;

  // Live drawing state
  private isDrawing = false;
  private lastClickTime = 0;
  private strokeStartTime: number = 0;
  private currentPoints: StrokePoint[] = [];
  private inkInputFilter = new InkInputFilter();
  /** Immutable owner of the active canvas gesture. Cleared on every finish. */
  private strokeModeAtStart: NotebookMode | null = null;
  private strokeContextAtStart: DrawingStrokeContext | null = null;
  private cachedCanvasRect: DOMRect | null = null;
  private cachedCssWidth = 0;
  private cachedCssHeight = 0;
  private lastProcessedClientX = -1;
  private lastProcessedClientY = -1;
  private inkSamples: InkSamples | null = null;
  private inkOwner: { canvas: HTMLCanvasElement | null; pageId: string | null } | null = null;
  private inkRawPoints: StrokePoint[] = [];
  private inkTrace: HandwritingTrace | null = null;
  private gate0InkGesture: Gate0Record | null = null;
  private gate0EraserGesture: Gate0Record | null = null;
  private gate0LastPointerDispatch: { type: string; x: number; y: number; timeStamp: number } | null = null;

  // Select-mode pointer routing. Transform gestures continue to be owned by
  // SelectionEngine; lasso only records the freehand enclosure passed to its existing
  // selectWithinLoop() implementation.
  private selectionDragMode: 'none' | 'transform' | 'lasso' = 'none';
  private lassoPoints: StrokePoint[] = [];

  private rulerManager: RulerManager;
  private rulerDragMode: Exclude<RulerHit, null> | null = null;
  private rulerPointerStart = { x: 0, y: 0 };
  private rulerCenterStart = { x: 0, y: 0 };
  private rulerRotationOffset = 0;
  private laserManager: LaserManager;
  private laserPointerActive = false;

  private isPanningOverride = false;

  // Change listeners (for autosave)
  private changeListeners: Set<DrawingChangeListener> = new Set();
  private strokeLifecycleListeners: Set<(event: InkStrokeLifecycleEvent) => void> = new Set();
  private drawingGestureListeners: Set<DrawingGestureListener> = new Set();
  private drawingGestureActive = false;

  constructor(
    toolManager: ToolManager,
    viewport: ViewportManager,
    drawingEngine: DrawingEngine,
    eraserEngine: EraserEngine,
    shapeManager: ShapeManager,
    selectionEngine: SelectionEngine,
    historyManager: HistoryManager,
    textManager: TextManager,
    rulerManager: RulerManager,
    laserManager: LaserManager,
  ) {
    this.toolManager = toolManager;
    this.viewport = viewport;
    this.drawingEngine = drawingEngine;
    this.eraserEngine = eraserEngine;
    this.shapeManager = shapeManager;
    this.selectionEngine = selectionEngine;
    this.historyManager = historyManager;
    this.textManager = textManager;
    this.rulerManager = rulerManager;
    this.eraserEngine.setRulerManager(rulerManager);
    this.laserManager = laserManager;
    this.eraserEngine.setHistoryChangeCallback(() => this.notifyChange());
  }

  /** Subscribe to drawing data changes (for autosave). Returns unsubscribe. */
  onDrawingChange(listener: DrawingChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onInkStrokeLifecycle(listener: (event: InkStrokeLifecycleEvent) => void): () => void {
    this.strokeLifecycleListeners.add(listener);
    return () => this.strokeLifecycleListeners.delete(listener);
  }

  /** Actual draw-mode contact lifecycle, independent of recognition eligibility. */
  onDrawingGestureLifecycle(listener: DrawingGestureListener): () => void {
    this.drawingGestureListeners.add(listener);
    return () => this.drawingGestureListeners.delete(listener);
  }

  /** Promote an incomplete single-pointer edit into a two-finger viewport gesture. */
  cancelActivePointerInteraction(): void {
    this.cancelTransientInteraction();
  }

  private notifyStrokeLifecycle(event: InkStrokeLifecycleEvent): void {
    for (const listener of this.strokeLifecycleListeners) listener(event);
  }

  private setDrawingGestureActive(active: boolean): void {
    if (this.drawingGestureActive === active) return;
    this.drawingGestureActive = active;
    for (const listener of this.drawingGestureListeners) listener(active);
  }

  notifyChange(): void {
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    for (const listener of this.changeListeners) {
      listener();
    }
    if (startedAt) gate0Profiler.event('drawing-notification', performance.now() - startedAt, { listeners: this.changeListeners.size });
  }

  /** DOM text surfaces yield to the existing canvas gesture owner for ink and upper-layer hits. */
  routeOverlayPointerDown(event: PointerEvent): void {
    this.handlePointerDown(event);
  }

  /** Attach event listeners to a canvas element. Call on mount. */
  attach(canvas: HTMLCanvasElement): void {
    // Idempotent. Previously a second attach() without a matching detach() left the
    // old listeners bound to a stale canvas while `this.canvas` pointed at the new one,
    // so every coordinate lookup and pointer-capture call targeted the wrong element.
    if (this.canvas) this.detach();

    this.canvas = canvas;
    this.rulerManager.setEnabled(this.toolManager.getState().rulerEnabled);
    this.unsubscribeToolState = this.toolManager.subscribe((state) => {
      if (state.mode !== 'select') this.clearSelectionCursor();
      if (state.mode !== 'draw' || state.drawingTool !== 'laser') {
        this.laserPointerActive = false;
        this.laserManager.clear();
      }
      if (this.rulerManager.setEnabled(state.rulerEnabled)) {
        if (!state.rulerEnabled) this.rulerDragMode = null;
        this.drawingEngine.redraw();
      }
    });
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
    canvas.addEventListener('lostpointercapture', this.handleEraserCaptureLost);
    if (typeof window !== 'undefined' && 'onpointerrawupdate' in window) {
      canvas.addEventListener('pointerrawupdate', this.handlePointerMove as EventListener);
    }
    // NOTE: `pointerleave` is deliberately NOT wired to handlePointerUp. Every gesture
    // start below calls setPointerCapture on this canvas, so `pointerup` is guaranteed
    // to be delivered here even when the button is released outside the element.
    // Ending the gesture on a boundary crossing only ever truncated live gestures.
    canvas.style.touchAction = 'none';
    if (typeof window !== 'undefined') window.addEventListener('blur', this.cancelTransientInteraction);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  /** Detach event listeners. Call on unmount. */
  detach(): void {
    this.flushPendingErasing();
    this.setDrawingGestureActive(false);
    this.unsubscribeToolState?.();
    this.unsubscribeToolState = null;
    if (!this.canvas) return;
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('lostpointercapture', this.handleEraserCaptureLost);
    if (typeof window !== 'undefined' && 'onpointerrawupdate' in window) {
      this.canvas.removeEventListener('pointerrawupdate', this.handlePointerMove as EventListener);
    }
    if (typeof window !== 'undefined') window.removeEventListener('blur', this.cancelTransientInteraction);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.clearSelectionCursor();
    this.rulerDragMode = null;
    this.laserPointerActive = false;
    this.isDrawing = false;
    this.drawingEngine?.endLiveStroke?.();
    this.cachedCanvasRect = null;
    this.cachedCssWidth = 0;
    this.cachedCssHeight = 0;
    this.lastProcessedClientX = -1;
    this.lastProcessedClientY = -1;
    this.clearInkSamples('detach');
    this.strokeModeAtStart = null;
    this.strokeContextAtStart = null;
    this.selectionDragMode = 'none';
    this.lassoPoints = [];
    this.laserManager.clear();
    this.canvas = null;
  }

  private clearSelectionCursor(): void {
    if (this.canvas && SELECTION_CURSORS.has(this.canvas.style.cursor)) {
      this.canvas.style.removeProperty('cursor');
    }
  }

  // ---- Event Handlers (bound as arrow functions for stable references) ----

  private handlePointerDown = (e: PointerEvent): void => {
    if (this.inkSamples) return;
    if (this.eraserGesture) return;
    const toolState = this.toolManager.getState();
    if (toolState.rulerEnabled && e.button === 0) {
      const point = this.getCanvasPoint(e);
      const rulerHit = this.rulerManager.hitTest(point.x, point.y);
      if (rulerHit && toolState.mode !== 'erase') {
        this.startRulerInteraction(e, point, rulerHit);
        return;
      }
    }
    const now = Date.now();
    
    // Check for double click to edit text box
    if (now - this.lastClickTime < 300) {
      if (toolState.mode === 'select') {
        const point = this.getCanvasPoint(e);
        this.selectionEngine.selectAt(point.x, point.y, false);
        const hit = this.selectionEngine.getSelectedElements()[0];
        if (hit && hit.type === 'text') {
           this.toolManager.setMode('text');
           document.dispatchEvent(new CustomEvent('panvas:focus-text', { detail: { id: hit.id } }));
           this.lastClickTime = 0; // reset
           return;
        }
      }
    }
    this.lastClickTime = now;

    // Handle middle-click pan override
    if (e.button === 1) {
      if (!this.ownsPanning(e)) return; // handled by the viewport-level controller
      e.preventDefault();
      this.isPanningOverride = true;
      this.startPanning(e);
      return;
    }

    // Ignore hover/barrel/right-button pointer events. On Windows, returning to the app
    // can otherwise surface a stale pen event that looks like a new drawing gesture.
    if (e.button !== 0) return;

    if (toolState.mode === 'draw' && toolState.drawingTool === 'laser') {
      if (e.button === 0) this.startLaser(e);
      return;
    }

    if (['draw', 'shape', 'text'].includes(toolState.mode) && !this.drawingEngine.canEditActiveLayer()) return;

    if (toolState.mode === 'draw') {
      this.startDrawing(e);
    } else if (toolState.mode === 'erase') {
      this.startErasing(e);
    } else if (toolState.mode === 'shape') {
      this.startShape(e);
    } else if (toolState.mode === 'select') {
      this.startSelection(e);
    } else if (toolState.mode === 'text') {
      this.createTextBox(e);
    } else if (toolState.mode === 'hand') {
      if (this.ownsPanning(e)) this.startPanning(e);
    }
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.inkSamples && !this.ownsInkEvent(e)) return;
    if (this.eraserGesture && e.pointerId !== this.eraserGesture.pointerId) return;
    const activeProfile = this.gate0InkGesture ?? this.gate0EraserGesture;
    if (activeProfile) {
      gate0Profiler.increment(activeProfile, e.type === 'pointerrawupdate' ? 'pointerrawupdateDispatches' : 'pointermoveDispatches');
      const previous = this.gate0LastPointerDispatch;
      if (previous && previous.type !== e.type && previous.x === e.clientX && previous.y === e.clientY && previous.timeStamp === e.timeStamp) {
        gate0Profiler.increment(activeProfile, 'overlappingRawAndMoveDispatches');
      }
      this.gate0LastPointerDispatch = { type: e.type, x: e.clientX, y: e.clientY, timeStamp: e.timeStamp };
    }
    // A pointerup can be swallowed while the native window is inactive. Mouse/pen hover
    // reports no pressed buttons, so cancel the orphaned transient gesture before routing
    // the move. Touch does not expose the same buttons contract.
    if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && e.buttons === 0 && (this.isDrawing || this.laserPointerActive)) {
      this.cancelTransientInteraction();
      return;
    }
    // Erasing has its own transport/deduplication. Pen input below is unchanged.
    if (this.eraserGesture) {
      this.continueErasing(e);
      return;
    }
    if (this.isDrawing && !this.inkSamples && e.clientX === this.lastProcessedClientX && e.clientY === this.lastProcessedClientY) {
      gate0Profiler.increment(activeProfile, 'rejectedDuplicateDispatches');
      return;
    }
    this.lastProcessedClientX = e.clientX;
    this.lastProcessedClientY = e.clientY;
    if (this.rulerDragMode) {
      this.continueRulerInteraction(e);
      return;
    }
    if (this.laserPointerActive) {
      this.continueLaser(e);
      return;
    }
    if (this.isPanningOverride) {
      this.continuePanning(e);
      return;
    }

    if (this.strokeModeAtStart === 'draw' && this.isDrawing) {
      this.continueDrawing(e);
    } else if (this.strokeModeAtStart === 'erase' && this.isDrawing) {
      this.continueErasing(e);
    } else if (this.strokeModeAtStart === 'shape' && this.isDrawing) {
      this.continueShape(e);
    } else if (this.strokeModeAtStart === 'select' && this.isDrawing) {
      this.continueSelection(e);
    } else if (this.strokeModeAtStart === 'hand' && this.isPanning) {
      this.continuePanning(e);
    } else if (this.toolManager.getState().mode === 'select') {
      if (this.isDrawing) {
        this.continueSelection(e);
      } else if (this.canvas) {
        const point = this.getCanvasPoint(e);
        const handleHit = this.selectionEngine.getHandleAt(point.x, point.y);
        if (handleHit) {
          switch (handleHit.handle) {
            case 'tl':
            case 'br':
              this.canvas.style.cursor = 'nwse-resize';
              break;
            case 'tr':
            case 'bl':
              this.canvas.style.cursor = 'nesw-resize';
              break;
            case 'tc':
            case 'bc':
              this.canvas.style.cursor = 'ns-resize';
              break;
            case 'ml':
            case 'mr':
              this.canvas.style.cursor = 'ew-resize';
              break;
            case 'rotate':
              this.canvas.style.cursor = 'grab';
              break;
            default:
              this.clearSelectionCursor();
          }
        } else {
          this.clearSelectionCursor();
        }
      }
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (this.inkSamples && !this.ownsInkEvent(e)) return;
    if (this.eraserGesture && e.pointerId !== this.eraserGesture.pointerId) return;
    if (this.eraserGesture) {
      // Finish before releasing capture: lostpointercapture may dispatch synchronously.
      if (e.type === 'pointerup') this.eraserGesture.enqueue(this.getCanvasPoint(e));
      this.flushPendingErasing(e.type);
      try { this.canvas?.releasePointerCapture(e.pointerId); } catch { /* Already released. */ }
      return;
    }
    if (this.rulerDragMode) {
      this.finishRulerInteraction(e);
      return;
    }
    if (this.laserPointerActive) {
      this.finishLaser(e);
      return;
    }
    if (this.isPanningOverride) {
      this.isPanningOverride = false;
      this.finishPanning(e);
      if (this.canvas) {
        try {
          this.canvas.releasePointerCapture(e.pointerId);
        } catch (err) {
          // Ignore DOMException if capture is already lost
        }
      }
      return;
    }

    if (this.canvas) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch (err) {
        // Ignore DOMException if capture is already lost
      }
    }

    if (this.strokeModeAtStart === 'draw' && this.isDrawing) {
      this.finishDrawing(e);
    } else if (this.strokeModeAtStart === 'shape' && this.isDrawing) {
      this.finishShape();
    } else if (this.strokeModeAtStart === 'select' && this.isDrawing) {
      this.finishSelection(e);
    } else if (this.strokeModeAtStart === 'hand' && this.isPanning) {
      this.finishPanning(e);
    }
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.cancelTransientInteraction();
  };

  private handleEraserCaptureLost = (e: PointerEvent): void => {
    if (this.eraserGesture?.pointerId === e.pointerId) this.flushPendingErasing('lost-capture');
  };

  private cancelTransientInteraction = (): void => {
    const wasErasing = this.eraserGesture !== null;
    this.flushPendingErasing('cancel');
    const cancelledContext = this.strokeContextAtStart;
    const wasDrawingInk = this.isDrawing && this.strokeModeAtStart === 'draw';

    this.isDrawing = false;
    this.setDrawingGestureActive(false);
    this.drawingEngine?.endLiveStroke?.();
    this.strokeModeAtStart = null;
    this.strokeContextAtStart = null;
    this.cachedCanvasRect = null;
    this.cachedCssWidth = 0;
    this.cachedCssHeight = 0;
    this.lastProcessedClientX = -1;
    this.lastProcessedClientY = -1;
    this.clearInkSamples('cancel');
    this.currentPoints = [];
    this.selectionDragMode = 'none';
    this.lassoPoints = [];
    this.rulerDragMode = null;
    this.isPanningOverride = false;
    this.isPanning = false;
    this.panScrollTarget = null;
    this.laserPointerActive = false;
    this.laserManager.clear();
    if (!wasErasing) this.drawingEngine.redraw();

    if (wasDrawingInk && cancelledContext?.recognitionEligible) {
      this.notifyStrokeLifecycle({
        type: 'cancel',
        instrument: cancelledContext.tool as 'pen' | 'pencil',
      });
    }
  };

  // ---- Transient Ruler Interaction ----

  private startRulerInteraction(e: PointerEvent, point: StrokePoint, mode: Exclude<RulerHit, null>): void {
    if (this.canvas) this.canvas.setPointerCapture(e.pointerId);
    this.rulerDragMode = mode;
    this.rulerPointerStart = { x: point.x, y: point.y };
    const state = this.rulerManager.getState();
    this.rulerCenterStart = { ...state.center };
    if (mode === 'rotate') {
      const pointerAngle = Math.atan2(point.y - state.center.y, point.x - state.center.x);
      this.rulerRotationOffset = state.angle - pointerAngle;
    }
  }

  private continueRulerInteraction(e: PointerEvent): void {
    if (!this.rulerDragMode) return;
    const point = this.getCanvasPoint(e);
    if (this.rulerDragMode === 'move') {
      this.rulerManager.setCenter(
        this.rulerCenterStart.x + point.x - this.rulerPointerStart.x,
        this.rulerCenterStart.y + point.y - this.rulerPointerStart.y,
      );
    } else if (this.rulerDragMode === 'rotate') {
      const center = this.rulerManager.getState().center;
      const pointerAngle = Math.atan2(point.y - center.y, point.x - center.x);
      this.rulerManager.setAngle(pointerAngle + this.rulerRotationOffset, true);
    } else {
      const state = this.rulerManager.getState();
      const dx = point.x - state.center.x;
      const dy = point.y - state.center.y;
      const localX = dx * Math.cos(state.angle) + dy * Math.sin(state.angle);
      this.rulerManager.setWidth(Math.abs(localX) * 2);
    }
    this.drawingEngine.redraw();
  }

  private finishRulerInteraction(e: PointerEvent): void {
    this.continueRulerInteraction(e);
    this.rulerDragMode = null;
    if (this.canvas) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may already have ended after cancellation.
      }
    }
    this.drawingEngine.redraw();
  }

  private createTextBox(e: PointerEvent): void {
    const point = this.getCanvasPoint(e);
    
    // Check if we hit an existing text box first
    this.selectionEngine.selectAt(point.x, point.y, false);
    const hit = this.selectionEngine.getSelectedElements()[0];
    if (hit && hit.type === 'text') {
      document.dispatchEvent(new CustomEvent('panvas:focus-text', { detail: { id: hit.id } }));
      return;
    }

    const newText = {
      fontFamily: this.textManager.getDefaultFontFamily(),
      id: generateId(),
      type: 'text' as const,
      x: point.x,
      y: point.y,
      width: 300,
      content: { 
        type: 'doc', 
        content: [{ 
          type: 'paragraph', 
          content: [{
            type: 'text',
            text: '',
            marks: [{ type: 'textStyle', attrs: { color: this.toolManager.getState().color, fontFamily: this.textManager.getDefaultFontFamily() } }]
          }] 
        }] 
      },
      createdAt: Date.now(),
    };
    this.textManager.addText(newText);
    this.selectionEngine.clearSelection();
    this.selectionEngine.selectAt(point.x, point.y, false);
    this.notifyChange();
    // Keep Text mode active. The selected object is durable state consumed by
    // FloatingTextEditor after React mounts it; dispatching focus here raced that mount and
    // switching to Select simultaneously disabled the editor that was meant to receive it.
  }

  // ---- Selection ----

  private startSelection(e: PointerEvent): void {
    if (this.canvas) {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {}
    }
    const point = this.getCanvasPoint(e);

    this.isDrawing = true;
    this.strokeModeAtStart = 'select';
    this.lassoPoints = [];

    // getHandleAt() and selectAt() preserve the existing handle, active-bounds,
    // click-to-select, and Shift+click behavior. Only a genuine empty-canvas hit starts
    // lasso collection.
    const handleHit = this.selectionEngine.getHandleAt(point.x, point.y);
    const hitSelectionOrElement = Boolean(handleHit)
      || this.selectionEngine.selectAt(point.x, point.y, e.shiftKey);

    if (hitSelectionOrElement) {
      this.selectionDragMode = 'transform';
      this.selectionEngine.startDrag(point.x, point.y);
      return;
    }

    this.selectionDragMode = 'lasso';
    this.lassoPoints = [point];
    this.drawingEngine.renderLasso(this.lassoPoints);
  }

  private continueSelection(e: PointerEvent): void {
    const point = this.getCanvasPoint(e);
    if (this.selectionDragMode === 'lasso') {
      this.lassoPoints.push(point);
      this.drawingEngine.renderLasso(this.lassoPoints);
      return;
    }

    if (this.selectionDragMode !== 'transform') return;
    this.selectionEngine.dragTo(point.x, point.y);
    if (this.selectionEngine.getSelectedElements().some(el => el.type === 'text')) {
      this.notifyChange();
    }
  }

  private finishSelection(e: PointerEvent): void {
    this.isDrawing = false;
    this.strokeModeAtStart = null;
    const point = this.getCanvasPoint(e);

    if (this.selectionDragMode === 'lasso') {
      this.lassoPoints.push(point);
      const completedLoop = this.lassoPoints;
      this.lassoPoints = [];
      this.selectionDragMode = 'none';
      if (completedLoop.length >= 3) {
        this.selectionEngine.selectWithinLoop(completedLoop);
      }
      // selectWithinLoop intentionally does not redraw when nothing is enclosed; always
      // redraw here so the transient lasso disappears for both hit and miss outcomes.
      this.drawingEngine.redraw();
      return;
    }

    this.selectionDragMode = 'none';
    const moved = this.selectionEngine.finishDrag(point.x, point.y);
    if (moved) {
      this.notifyChange();
    }
  }

  // ---- Panning ----
  //
  // Panning ownership is split deliberately. In the notebook, the `.notebook-viewport`
  // scroll container owns mouse/pen panning (see NotebookRenderer) because a hand drag
  // must work when it starts on an inter-page gap, a side margin, or a non-focused page
  // — none of which are this canvas. Two cases still belong to the canvas:
  //   * The PDF workspace has no `.notebook-viewport`; it pans a shared CSS camera.
  //   * Touch, because `touch-action: none` (set in attach) suppresses native scrolling
  //     on this canvas, while the viewport controller leaves touch to native scrolling.
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartScrollLeft = 0;
  private panStartScrollTop = 0;
  private panStartOffsetX = 0;
  private panStartOffsetY = 0;
  private panScrollTarget: Element | null = null;

  private ownsPanning(e: PointerEvent): boolean {
    if (!this.canvas) return false;
    if (e.pointerType === 'touch') return true;
    return !this.canvas.closest('.notebook-viewport');
  }

  private startPanning(e: PointerEvent): void {
    if (!this.canvas) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      // Ignore DOMException if the pointer is already gone
    }
    this.isPanning = true;
    this.strokeModeAtStart = 'hand';
    this.panStartX = e.clientX;
    this.panStartY = e.clientY;

    this.panScrollTarget = this.canvas.closest('.notebook-viewport');
    if (this.panScrollTarget) {
      this.panStartScrollLeft = this.panScrollTarget.scrollLeft;
      this.panStartScrollTop = this.panScrollTarget.scrollTop;
    } else {
      const state = this.viewport.getState();
      this.panStartOffsetX = state.offsetX;
      this.panStartOffsetY = state.offsetY;
    }
  }

  private continuePanning(e: PointerEvent): void {
    if (!this.isPanning) return;

    // Absolute target from the gesture anchor. The previous implementation rebased the
    // anchor on every move, so any motion the scroller clamped away or rounded off was
    // permanently discarded instead of deferred — the cause of the content lagging
    // behind the cursor, worst at fractional display scaling.
    const dx = e.clientX - this.panStartX;
    const dy = e.clientY - this.panStartY;

    if (this.panScrollTarget) {
      this.panScrollTarget.scrollLeft = this.panStartScrollLeft - dx;
      this.panScrollTarget.scrollTop = this.panStartScrollTop - dy;
    } else {
      this.viewport.setPan(this.panStartOffsetX + dx, this.panStartOffsetY + dy);
    }
  }

  private finishPanning(_e: PointerEvent): void {
    this.isPanning = false;
    this.strokeModeAtStart = null;
    this.panScrollTarget = null;
  }

  // ---- Drawing ----

  private startLaser(e: PointerEvent): void {
    if (this.canvas) this.canvas.setPointerCapture(e.pointerId);
    this.laserPointerActive = true;
    this.strokeStartTime = Date.now();
    this.laserManager.addPoint(this.getCanvasPoint(e));
  }

  private continueLaser(e: PointerEvent): void {
    if (!this.laserPointerActive) return;
    this.laserManager.addPoint(this.getCanvasPoint(e));
  }

  private finishLaser(e: PointerEvent): void {
    this.continueLaser(e);
    this.laserPointerActive = false;
    if (this.canvas) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may already have ended after cancellation.
      }
    }
  }

  private getCanvasPoint(e: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerType' | 'pressure'>): StrokePoint {
    if (!this.canvas) return { x: 0, y: 0, pressure: 0.5, t: 0 };

    const useCache = this.isDrawing && this.strokeModeAtStart === 'draw' && Boolean(this.cachedCanvasRect);
    const rect = useCache ? this.cachedCanvasRect! : this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0, pressure: 0.5, t: 0 };

    // Base document CSS dimensions of the canvas
    const cssWidth = (useCache && this.cachedCssWidth > 0)
      ? this.cachedCssWidth
      : (this.canvas.clientWidth || (this.canvas.width / (window.devicePixelRatio || 1)));
    const cssHeight = (useCache && this.cachedCssHeight > 0)
      ? this.cachedCssHeight
      : (this.canvas.clientHeight || (this.canvas.height / (window.devicePixelRatio || 1)));

    // First map client pixels into the canvas CSS box. PDF canvases use zoomed CSS
    // dimensions and apply the same zoom in the drawing context, so ViewportManager then
    // removes that render scale. Notebook canvases render in base coordinates and pass
    // through unchanged. DPR never enters this conversion.
    const canvasX = ((e.clientX - rect.left) / rect.width) * cssWidth;
    const canvasY = ((e.clientY - rect.top) / rect.height) * cssHeight;
    const { x, y } = this.viewport.canvasToPage(canvasX, canvasY);

    // Native pressure: mouse = 0.5, stylus = actual pressure
    const pressure = mapPointerPressure(
      e.pointerType,
      e.pressure,
      this.strokeContextAtStart?.pressureSensitivity ?? true,
    );

    return {
      x,
      y,
      pressure,
      t: Date.now() - this.strokeStartTime,
    };
  }

  private startDrawing(e: PointerEvent): void {
    this.gate0InkGesture = gate0Profiler.start('ink-gesture', { pointerType: e.pointerType });
    this.gate0LastPointerDispatch = null;
    if (this.canvas) {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture can fail in synthetic tests or if pointer was already lost
      }
      this.cachedCanvasRect = this.canvas.getBoundingClientRect();
      this.cachedCssWidth = this.canvas.clientWidth || (this.canvas.width / (window.devicePixelRatio || 1));
      this.cachedCssHeight = this.canvas.clientHeight || (this.canvas.height / (window.devicePixelRatio || 1));
    }
    this.isDrawing = true;
    this.setDrawingGestureActive(true);
    this.inkSamples = new InkSamples(e);
    this.inkOwner = { canvas: this.canvas, pageId: this.eraserOwnerPageId };
    this.inkTrace = startHandwritingTrace();
    this.drawingEngine?.beginLiveStroke?.(this.inkTrace);
    const toolState = this.toolManager.getState();
    this.strokeModeAtStart = toolState.mode;
    this.strokeContextAtStart = resolveDrawingStrokeContext(toolState);
    this.strokeStartTime = Date.now();
    this.inkInputFilter.reset();
    this.currentPoints = [];
    this.inkRawPoints = [];
    this.acceptInkSamples(e);
    const firstPoint = this.inkRawPoints[this.inkRawPoints.length - 1];
    gate0Profiler.increment(this.gate0InkGesture, 'liveRenderInvocations');
    this.drawingEngine.renderLiveStroke(
      this.currentPoints,
      this.strokeContextAtStart.tool,
      this.strokeContextAtStart.color,
      this.strokeContextAtStart.thickness,
      this.strokeContextAtStart.opacity,
      this.strokeContextAtStart.strokePattern,
      this.strokeContextAtStart.inkFamily,
      firstPoint,
    );
    if (this.strokeContextAtStart.recognitionEligible) {
      this.notifyStrokeLifecycle({
        type: 'start',
        instrument: this.strokeContextAtStart.tool as 'pen' | 'pencil',
      });
    }
  }

  private continueDrawing(e: PointerEvent): void {
    const startedAt = this.inkTrace ? performance.now() : 0;
    const strokeContext = this.strokeContextAtStart ?? resolveDrawingStrokeContext(this.toolManager.getState());
    if (!this.acceptInkSamples(e)) {
      this.traceInkTiming('pointerHandlerMs', startedAt);
      return;
    }
    const latestRawPoint = this.inkRawPoints[this.inkRawPoints.length - 1];
    const renderStartedAt = this.inkTrace ? performance.now() : 0;

    this.drawingEngine.renderLiveStroke(
      this.currentPoints,
      strokeContext.tool,
      strokeContext.color,
      strokeContext.thickness,
      strokeContext.opacity,
      strokeContext.strokePattern,
      strokeContext.inkFamily,
      latestRawPoint,
    );
    gate0Profiler.increment(this.gate0InkGesture, 'liveRenderInvocations');
    gate0Profiler.sample(this.gate0InkGesture, 'currentStrokePointCount', this.currentPoints.length);
    this.traceInkTiming('renderMs', renderStartedAt);
    this.traceInkTiming('pointerHandlerMs', startedAt);
  }

  private ownsInkEvent(e: PointerEvent): boolean {
    return Boolean(this.inkSamples?.owns(e) && this.inkOwner?.canvas === this.canvas
      && this.inkOwner.pageId === this.eraserOwnerPageId);
  }

  private traceInkTiming(name: string, start: number): void {
    if (this.inkTrace) (this.inkTrace.timings[name] ??= []).push(performance.now() - start);
  }

  private acceptInkSamples(e: PointerEvent): boolean {
    const stream = this.inkSamples;
    if (!stream || !this.ownsInkEvent(e)) return false;
    const startedAt = this.inkTrace ? performance.now() : 0;
    const oldLength = stream.samples.length;
    const result = stream.consume(e);
    this.traceInkTiming('normalizationMs', startedAt);
    gate0Profiler.increment(this.gate0InkGesture, 'coalescedSamples', result.coalesced);
    gate0Profiler.increment(this.gate0InkGesture, 'acceptedPoints', result.added);
    if (this.inkTrace) {
      const counters = this.inkTrace.counters;
      for (const [key, count] of Object.entries({ dispatches: 1, [e.type]: 1, coalescedSamples: result.coalesced,
        normalizedSamples: result.added, exactDuplicates: result.duplicates, stationaryUp: result.stationaryUp,
        rejectedOwner: result.rejectedOwner, invalid: result.invalid, rebuilds: Number(result.rebuild) })) {
        counters[key] = (counters[key] ?? 0) + count;
      }
      this.inkTrace.raw.push(...result.raw.map(sample => ({ ...sample, processingTime: performance.now() })));
    }
    if (!result.added) return false;
    // A delayed dispatch can contribute unique older history. Refilter in chronological
    // order rather than dropping that history or inserting a backwards segment.
    if (result.rebuild) {
      this.inkInputFilter.reset();
      this.currentPoints = [];
      this.inkRawPoints = [];
    }
    const context = this.strokeContextAtStart!;
    for (let i = result.rebuild ? 0 : oldLength; i < stream.samples.length; i++) {
      const sample = stream.samples[i];
      const raw = this.getRulerConstrainedPoint(sample);
      // Lift events commonly report zero pressure. Retain the last contact
      // pressure while preserving a distinct terminal XY/timestamp.
      if (e.type === 'pointerup' && sample.timeStamp === e.timeStamp && sample.pressure === 0
        && this.inkRawPoints.length) raw.pressure = this.inkRawPoints[this.inkRawPoints.length - 1].pressure;
      raw.t = sample.timeStamp - stream.startedAt;
      this.inkRawPoints.push(raw);
      this.currentPoints.push(this.inkInputFilter.push(raw, context.stabilization));
      if (this.inkTrace) {
        this.inkTrace.counters.filterInputs = (this.inkTrace.counters.filterInputs ?? 0) + 1;
        this.inkTrace.counters.filteredOutputs = (this.inkTrace.counters.filteredOutputs ?? 0) + 1;
      }
    }
    return true;
  }

  private clearInkSamples(outcome: string, committed: StrokePoint[] = []): void {
    if (this.inkTrace) {
      this.inkTrace.normalized = this.inkSamples?.samples.map(sample => ({ ...sample })) ?? [];
      this.inkTrace.stabilized = this.currentPoints.map(point => ({ ...point }));
      this.inkTrace.committed = committed.map(point => ({ ...point }));
      this.inkTrace.counters.committedPoints = committed.length;
      const raw = this.inkRawPoints[this.inkRawPoints.length - 1], final = committed[committed.length - 1];
      this.inkTrace.finalEndpointDifference = raw && final ? Math.hypot(raw.x - final.x, raw.y - final.y) : 0;
      finishHandwritingTrace(this.inkTrace, outcome);
    }
    this.inkTrace = null;
    this.inkSamples = null;
    this.inkOwner = null;
    this.inkRawPoints = [];
  }

  private getRulerConstrainedPoint(e: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerType' | 'pressure'>): StrokePoint {
    const point = this.getCanvasPoint(e);
    return this.rulerManager.snapPointToEdge(point).point;
  }

  private finishDrawing(e: PointerEvent): void {
    const traceStartedAt = this.inkTrace ? performance.now() : 0;
    if (e.type === 'pointerup') this.acceptInkSamples(e);
    const finalTip = this.inkRawPoints[this.inkRawPoints.length - 1];
    const filteredPoints = this.currentPoints;
    // Exactly the same endpoint extension used by the live renderer. Do not feed
    // the raw tip back through stabilization or change the filter's parameters.
    if (finalTip && this.currentPoints.length && (this.currentPoints[this.currentPoints.length - 1].x !== finalTip.x
      || this.currentPoints[this.currentPoints.length - 1].y !== finalTip.y)) this.currentPoints = [...this.currentPoints, { ...finalTip }];
    const finishStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    this.isDrawing = false;
    this.setDrawingGestureActive(false);
    this.cachedCanvasRect = null;
    this.cachedCssWidth = 0;
    this.cachedCssHeight = 0;
    this.lastProcessedClientX = -1;
    this.lastProcessedClientY = -1;
    // Keep trace ownership until this commit has been recorded; release input now.
    const trace = this.inkTrace;
    if (trace) trace.stabilized = filteredPoints.map(point => ({ ...point }));
    if (trace) trace.normalized = this.inkSamples?.samples.map(sample => ({ ...sample })) ?? [];
    this.inkSamples = null;
    this.inkOwner = null;
    const gestureMode = this.strokeModeAtStart;
    this.strokeModeAtStart = null;
    const strokeContext = this.strokeContextAtStart ?? resolveDrawingStrokeContext(this.toolManager.getState());
    this.strokeContextAtStart = null;
    try {
      if (this.currentPoints.length < 1) {
        this.currentPoints = [];
        this.drawingEngine.redraw();
        if (strokeContext.recognitionEligible) {
          this.notifyStrokeLifecycle({
            type: 'cancel',
            instrument: strokeContext.tool as 'pen' | 'pencil',
          });
        }
        gate0Profiler.finish(this.gate0InkGesture, { finishDrawingMs: finishStartedAt ? performance.now() - finishStartedAt : 0, cancelled: true });
        this.gate0InkGesture = null;
        return;
      }

      const toolState = this.toolManager.getState();
      if (
        !strokeContext.recognitionEligible
        && gestureMode === 'draw'
        && toolState.scribbleToErase
        && (strokeContext.tool === 'pen' || strokeContext.tool === 'pencil')
        && analyzeScribble(this.currentPoints).isScribble
      ) {
        const targets = findScribbleTargets(
          this.currentPoints,
          (x, y, radius) => this.drawingEngine.findStrokesNearPoint(x, y, radius),
          Math.max(3, strokeContext.thickness),
        );
        if (this.eraserEngine.eraseStrokeIds(targets)) {
          this.currentPoints = [];
          this.notifyChange();
          return;
        }
      }

      if (
        !strokeContext.recognitionEligible
        && gestureMode === 'draw'
        && toolState.circleToSelect
        && (strokeContext.tool === 'pen' || strokeContext.tool === 'pencil')
        && analyzeCircleGesture(this.currentPoints).isCircle
        && this.selectionEngine.selectWithinLoop(this.currentPoints) > 0
      ) {
        this.currentPoints = [];
        this.toolManager.setMode('select');
        return;
      }

      const recognizedLine = !strokeContext.recognitionEligible && gestureMode === 'draw' && toolState.straightLineRecognition
        ? recognizeStraightLine(this.currentPoints, toolState.snapRecognizedLines)
        : null;
      const recognizedShape = !recognizedLine?.isLine
        && gestureMode === 'draw'
        && !strokeContext.recognitionEligible
        && toolState.roughShapeRecognition
        && (strokeContext.tool === 'pen' || strokeContext.tool === 'pencil')
        ? recognizeRoughShape(this.currentPoints, toolState.snapRecognizedShapes)
        : null;

      if (recognizedShape?.isShape && recognizedShape.shapeType) {
        const shape: Shape = {
          id: generateId('shp'),
          type: 'shape',
          shapeType: recognizedShape.shapeType,
          x: recognizedShape.x,
          y: recognizedShape.y,
          width: recognizedShape.width,
          height: recognizedShape.height,
          color: strokeContext.color,
          strokeWidth: strokeContext.thickness,
          fill: null,
          rotation: 0,
          opacity: strokeContext.opacity,
          createdAt: Date.now(),
        };
        this.shapeManager.addShape(shape);
        this.drawingEngine.redraw();
        this.recordCommittedShape(shape, `Recognize ${shape.shapeType}`);
        this.currentPoints = [];
        return;
      }

      const committedPoints = recognizedLine?.isLine
        ? recognizedLine.points
        : this.currentPoints;

      if (trace) {
        trace.committed = committedPoints.map(point => ({ ...point }));
        trace.counters.committedPoints = committedPoints.length;
        const endpoint = committedPoints[committedPoints.length - 1];
        trace.finalEndpointDifference = endpoint && finalTip ? Math.hypot(endpoint.x - finalTip.x, endpoint.y - finalTip.y) : 0;
      }

      const stroke = {
        id: generateId('strk'),
        type: 'stroke' as const,
        tool: strokeContext.tool,
        points: committedPoints,
        color: strokeContext.color,
        thickness: strokeContext.thickness,
        opacity: strokeContext.opacity,
        pattern: strokeContext.strokePattern,
        inkFamily: strokeContext.inkFamily,
        centerline: 'polyline' as const,
        createdAt: Date.now(),
      };

      // Add stroke to engine
      const commitPaintStartedAt = trace ? performance.now() : 0;
      this.drawingEngine.addStroke(stroke);
      this.drawingEngine.commitLiveStroke(stroke);
      this.traceInkTiming('commitPaintMs', commitPaintStartedAt);

      // Push to unified history (already executed, so use pushExecuted)
      const historyStartedAt = trace ? performance.now() : 0;
      this.historyManager.pushExecuted({
        description: `Draw ${stroke.tool} stroke`,
        createdObjectIds: [stroke.id],
        execute: () => {
          this.drawingEngine.addStroke(stroke);
          this.drawingEngine.redraw();
          this.notifyChange();
        },
        undo: () => {
          this.drawingEngine.removeStroke(stroke.id);
          this.drawingEngine.redraw();
          this.notifyChange();
        },
      });

      this.traceInkTiming('historyAndCaptureMs', historyStartedAt);
      this.currentPoints = [];
      const notifyStartedAt = trace ? performance.now() : 0;
      this.notifyChange();
      this.traceInkTiming('notificationMs', notifyStartedAt);
      if (strokeContext.recognitionEligible) {
        this.notifyStrokeLifecycle({
          type: 'complete',
          instrument: strokeContext.tool as 'pen' | 'pencil',
          stroke: structuredClone(stroke),
        });
      }
      gate0Profiler.finish(this.gate0InkGesture, {
        finishDrawingMs: finishStartedAt ? performance.now() - finishStartedAt : 0,
        committedPoints: stroke.points.length,
        tool: stroke.tool,
      });
      this.gate0InkGesture = null;
    } finally {
      this.drawingEngine.endLiveStroke();
      if (trace) trace.mapped = this.inkRawPoints.map(point => ({ ...point }));
      this.traceInkTiming('pointerUpTailMs', traceStartedAt);
      finishHandwritingTrace(trace, e.type === 'pointercancel' ? 'cancel' : 'complete');
      this.inkTrace = null;
      this.inkRawPoints = [];
    }
  }

  // ---- Erasing ----
  private eraserGesture: EraserGesture | null = null;
  private eraserOwnerPageId: string | null = null;

  setEraserPageOwner(pageId: string | null): void {
    // Existing scene replacement boundary also invalidates this engine's transient ink.
    if (this.inkSamples) this.cancelTransientInteraction();
    this.flushPendingErasing('page-replacement');
    this.eraserOwnerPageId = pageId;
  }

  private startErasing(e: PointerEvent): void {
    this.gate0EraserGesture = gate0Profiler.start('eraser-gesture', { pointerType: e.pointerType });
    this.gate0LastPointerDispatch = null;
    if (this.canvas) {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {}
    }
    this.isDrawing = true;
    this.strokeModeAtStart = 'erase';
    
    const toolState = this.toolManager.getState();
    const point = this.getCanvasPoint(e);
    const radius = Math.max(3, toolState.thickness || 12);
    // Capture owning managers, mode and radius once; never look up a newly active page.
    const eraser = this.eraserEngine;
    this.eraserGesture = new EraserGesture(
      e.pointerId, typeof window !== 'undefined' && 'onpointerrawupdate' in window,
      toolState.eraserMode, radius,
      {
        pageId: this.eraserOwnerPageId,
        begin: mode => eraser.startErasing(mode, false),
        sweep: (start, end, mode, width) => eraser.eraseSweep(start, end, mode, width, false),
        present: () => eraser.present(),
        complete: () => eraser.finishErasing(),
      },
      this.gate0EraserGesture,
      undefined, 8, true,
    );
    this.eraserGesture.enqueue(point);
  }

  private continueErasing(e: PointerEvent): void {
    const gesture = this.eraserGesture;
    if (!gesture?.acceptsMovement(e)) return;
    const samples = e.getCoalescedEvents?.() ?? [];
    for (const sample of samples) gesture.enqueue(this.getCanvasPoint(sample));
    gesture.enqueue(this.getCanvasPoint(e));
    gate0Profiler.increment(this.gate0EraserGesture, 'moveSamples', Math.max(1, samples.length));
  }

  flushPendingErasing(reason = 'ownership-flush'): void {
    const gesture = this.eraserGesture;
    if (!gesture) return;
    const profile = this.gate0EraserGesture;
    const started = performance.now();
    // Clear the input owner before synchronous history listeners capture the scene.
    this.eraserGesture = null;
    this.isDrawing = false;
    this.strokeModeAtStart = null;
    const changed = gesture.finish();
    if (changed) {
      this.notifyChange();
    }
    gate0Profiler.finish(profile, { changed, completionReason: reason, pointerUpTailMs: reason === 'pointerup' ? performance.now() - started : null });
    this.gate0EraserGesture = null;
  }

  // ---- Shape Drawing ----
  private shapeStartPoint = { x: 0, y: 0 };
  private activeShapeId: string | null = null;

  private startShape(e: PointerEvent): void {
    if (this.canvas) {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {}
    }
    this.isDrawing = true;
    this.strokeModeAtStart = 'shape';
    this.shapeStartPoint = this.getCanvasPoint(e);
    
    const toolState = this.toolManager.getState();
    this.activeShapeId = generateId('shp');
    
    // Draw an initial tiny shape
    this.shapeManager.addShape({
      id: this.activeShapeId,
      type: 'shape',
      shapeType: toolState.shapeTool,
      lineStyle: toolState.lineStyle,
      x: this.shapeStartPoint.x,
      y: this.shapeStartPoint.y,
      width: 0,
      height: 0,
      color: toolState.color,
      strokeWidth: toolState.thickness,
      fill: toolState.shapeFillEnabled ? toolState.color : null,
      rotation: 0,
      opacity: toolState.opacity,
      createdAt: Date.now(),
    });
    this.drawingEngine.redraw();
  }

  private continueShape(e: PointerEvent): void {
    if (!this.activeShapeId) return;
    const point = this.getCanvasPoint(e);
    const shape = this.shapeManager.getShapes().find(s => s.id === this.activeShapeId);
    if (!shape) return;

    Object.assign(shape, constrainShapeDrag(shape.shapeType, this.shapeStartPoint, point, e.shiftKey));

    this.drawingEngine.redraw();
  }

  private finishShape(): void {
    this.isDrawing = false;
    this.strokeModeAtStart = null;
    if (!this.activeShapeId) return;
    
    const shape = this.shapeManager.getShapes().find(s => s.id === this.activeShapeId);
    this.activeShapeId = null;

    if (!shape) return;

    // If it's too small, remove it
    if (Math.hypot(shape.width, shape.height) < 5) {
      this.shapeManager.removeShape(shape.id);
      this.drawingEngine.redraw();
      return;
    }

    this.recordCommittedShape(shape, 'Draw shape');
  }

  private recordCommittedShape(shape: Shape, description: string): void {
    // Deep clone the final shape for undo/redo history safety because the live shape can
    // be modified or removed by later selection actions.
    const finalShape: Shape = JSON.parse(JSON.stringify(shape));
    this.historyManager.pushExecuted({
      description,
      execute: () => {
        // If we redo, we must add a fresh clone of finalShape
        this.shapeManager.addShape(JSON.parse(JSON.stringify(finalShape)));
        this.drawingEngine.redraw();
        this.notifyChange();
      },
      undo: () => {
        this.shapeManager.removeShape(finalShape.id);
        this.drawingEngine.redraw();
        this.notifyChange();
      }
    });

    this.notifyChange();
  }
}
