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
import { recognizeStraightLine, recognizeArrowGesture } from './straightLineGesture.ts';
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
import { inkWidthAt } from './inkFamilyGeometry.ts';
import { InkCenterline } from './inkCenterline.ts';
import { gate0Profiler, type Gate0Record } from '../../../dev/gate0Profiler.ts';
import { EraserGesture } from './EraserGesture.ts';
import { InkSamples } from './inkSamples.ts';
import { startHandwritingTrace, finishHandwritingTrace, type HandwritingTrace } from '../../../dev/handwritingTrace.ts';
import { NavigationGestureLifecycle } from './NavigationGestureLifecycle.ts';
import { setSelectionGestureActive } from '../../../services/cloudsync/drawingActivity.ts';

export type DrawingChangeListener = (reason?: 'document-text') => void;
export type DrawingGestureListener = (active: boolean) => void;
export type InkStrokeLifecycleEvent =
  | { type: 'start'; instrument: 'pen' | 'pencil' }
  | { type: 'cancel'; instrument: 'pen' | 'pencil' }
  | { type: 'complete'; instrument: 'pen' | 'pencil'; stroke: Stroke; physicalPoints: StrokePoint[] };

const SELECTION_CURSORS = new Set([
  'default',
  'nwse-resize',
  'nesw-resize',
  'ns-resize',
  'ew-resize',
  'grab',
]);

const HOLD_SNAP_DELAY_MS = 350;
const HOLD_SNAP_RETRY_MS = 180;
const HOLD_SNAP_JITTER_CSS_PX = 14;
const HOLD_SNAP_MIN_PATH_CSS_PX = 20;
const SHAPE_DIAG_MAX_ENTRIES = 15;

export interface ShapeRecognitionDiagnostic {
  ts: number;
  pointerType: string;
  tool: string;
  layout: 'document' | 'freeform';
  zoom: number;
  toggles: {
    scribbleToErase: boolean;
    circleToSelect: boolean;
    straightLineRecognition: boolean;
    snapRecognizedLines: boolean;
    roughShapeRecognition: boolean;
    snapRecognizedShapes: boolean;
    rulerEnabled: boolean;
    handwritingToTextEnabled: boolean;
  };
  pointCount: number;
  pathLenCss: number;
  holdTimerFired: boolean;
  holdElapsedMs: number;
  maxHoldDriftCss: number;
  straightLineResult: {
    isLine: boolean;
    length: number;
    efficiency: number;
    maxDeviation: number;
    snappedAngle: number | null;
  } | null;
  roughShapeResult: {
    isShape: boolean;
    shapeType: string | null;
    width: number;
    height: number;
    rotation: number;
  } | null;
  circleSelectIntercepted: boolean;
  finalOutcome: 'snapped-line' | 'snapped-shape' | 'freehand-stroke' | 'scribble-erased' | 'circle-selected' | 'cancelled';
  rejectReason: string | null;
}

type HoldSnapState =
  | {
      kind: 'line';
      shape: Shape;
      start: StrokePoint;
      end: StrokePoint;
      snappedAngle: number | null;
      adjustEngaged: boolean;
    }
  | {
      kind: 'shape';
      shape: Shape;
      center: { x: number; y: number };
      initialPointerDistance: number;
      initialPointerAngle: number;
      initialWidth: number;
      initialHeight: number;
      initialRotation: number;
      isCircle: boolean;
      adjustEngaged: boolean;
    };

export class InputManager {
  readonly navigationGestures = new NavigationGestureLifecycle();
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
  private lastClickPoint: { x: number; y: number } | null = null;
  private lastClickPointerType = '';
  private strokeStartPerfMs: number = 0;
  private currentPoints: StrokePoint[] = [];
  private layoutModeGetter: () => 'document' | 'freeform' = () => 'freeform';

  /** Register a lightweight getter for current page layout mode ('document' | 'freeform'). */
  setLayoutModeGetter(getter: () => 'document' | 'freeform'): void {
    this.layoutModeGetter = getter;
  }

  /** Lowest page-space y of the in-flight stroke, for live document-extent
   *  growth on infinite pages. -Infinity when no stroke is in flight. */
  getLiveStrokeBottom(): number {
    if (this.holdSnapState?.kind === 'shape') {
      const { x, y, width, height, rotation } = this.holdSnapState.shape;
      const cx = x + width * 0.5;
      const cy = y + height * 0.5;
      const rad = (rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      let bottom = -Infinity;
      for (const [px, py] of [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]) {
        const ry = cy + (px - cx) * sin + (py - cy) * cos;
        if (ry > bottom) bottom = ry;
      }
      return bottom;
    }
    if (this.holdSnapState?.kind === 'line') {
      return Math.max(this.holdSnapState.start.y, this.holdSnapState.end.y);
    }
    let bottom = -Infinity;
    for (const point of this.currentPoints) bottom = Math.max(bottom, point.y);
    return bottom;
  }
  private holdSnapTimer: ReturnType<typeof setTimeout> | null = null;
  private holdSnapAnchor: { clientX: number; clientY: number; sincePerfMs: number; maxDriftCss: number } | null = null;
  private holdSnapState: HoldSnapState | null = null;
  private strokePointerType = 'mouse';
  private strokeLastClientX = 0;
  private strokeLastClientY = 0;
  private strokePathLenCss = 0;
  private holdTimerFired = false;
  private holdElapsedMs = 0;
  private holdMaxDriftCss = 0;
  private holdLastAttemptPointCount = -1;
  private lastStraightLineDiag: ShapeRecognitionDiagnostic['straightLineResult'] = null;
  private lastRoughShapeDiag: ShapeRecognitionDiagnostic['roughShapeResult'] = null;
  private inkInputFilter = new InkInputFilter();
  private inkCenterline = new InkCenterline();
  private inkScreenScale = 1;
  private inkRulerSnapped = false;
  /** Immutable owner of the active canvas gesture. Cleared on every finish. */
  private strokeModeAtStart: NotebookMode | null = null;
  private strokeContextAtStart: DrawingStrokeContext | null = null;
  private cachedCanvasRect: DOMRect | null = null;
  private cachedCssWidth = 0;
  private cachedCssHeight = 0;
  private predictedPointsScratch: StrokePoint[] = [];
  private lastProcessedClientX = -1;
  private lastProcessedClientY = -1;
  private inkSamples: InkSamples | null = null;
  private inkOwner: { canvas: HTMLCanvasElement | null; pageId: string | null } | null = null;
  private inkRawPoints: StrokePoint[] = [];
  /** Filter/centerline state per processed dispatch batch, so an out-of-order
   * coalesced sample can be refiltered incrementally instead of revising the
   * whole displayed stroke. Checkpoints strictly precede their sample count. */
  private inkFilterCheckpoints: {
    samples: number;
    rawPoints: number;
    filteredPoints: number;
    filter: ReturnType<InkInputFilter['checkpoint']>;
    centerline: ReturnType<InkCenterline['checkpoint']>;
    rulerSnapped: boolean;
  }[] = [];
  private static readonly INK_CHECKPOINT_LIMIT = 96;
  /** Geometry revision start for the next renderLiveStroke call. */
  private liveRevisionFrom = Infinity;
  private inkTrace: HandwritingTrace | null = null;
  private gate0InkGesture: Gate0Record | null = null;
  private gate0EraserGesture: Gate0Record | null = null;
  private gate0LastPointerDispatch: { type: string; x: number; y: number; timeStamp: number } | null = null;

  // Select-mode pointer routing. Transform gestures continue to be owned by
  // SelectionEngine; lasso only records the freehand enclosure passed to its existing
  // selectWithinLoop() implementation.
  private selectionDragMode: 'none' | 'transform' | 'lasso' = 'none';
  private lassoPoints: StrokePoint[] = [];
  private lassoShape: 'freeform' | 'rectangle' = 'freeform';
  private lassoStartPoint: StrokePoint | null = null;
  private selectionRafId: number | null = null;
  private pendingSelectionPoint: StrokePoint | null = null;
  private lassoRafId: number | null = null;
  private holdSnapPreviewRafId: number | null = null;
  private pendingHoldSnapPreview: (() => void) | null = null;

  private cancelTransientAnimationFrames(): void {
    if (this.selectionRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.selectionRafId);
      this.selectionRafId = null;
    }
    this.pendingSelectionPoint = null;
    if (this.lassoRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.lassoRafId);
      this.lassoRafId = null;
    }
    if (this.holdSnapPreviewRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.holdSnapPreviewRafId);
      this.holdSnapPreviewRafId = null;
    }
    this.pendingHoldSnapPreview = null;
  }

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

  isDrawingGestureActive(): boolean {
    return this.drawingGestureActive;
  }
  private getCanvasCssSize(canvas: HTMLCanvasElement): { width: number; height: number } {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return {
      width: canvas.clientWidth || parseFloat(canvas.style.width) || (canvas.width / dpr),
      height: canvas.clientHeight || parseFloat(canvas.style.height) || (canvas.height / dpr),
    };
  }

  /** Preserve a captured pointer when a bounded raster changes its DOM origin. */
  refreshCanvasGeometry(): void {
    if (!this.canvas || !this.cachedCanvasRect) return;
    this.cachedCanvasRect = this.canvas.getBoundingClientRect();
    const cssSize = this.getCanvasCssSize(this.canvas);
    this.cachedCssWidth = cssSize.width;
    this.cachedCssHeight = cssSize.height;
  }

  private cacheCanvasRectForGesture(): void {
    if (!this.canvas) return;
    this.cachedCanvasRect = this.canvas.getBoundingClientRect();
    const cssSize = this.getCanvasCssSize(this.canvas);
    this.cachedCssWidth = cssSize.width;
    this.cachedCssHeight = cssSize.height;
  }

  private clearCachedCanvasRect = (): void => {
    this.cachedCanvasRect = null;
    this.cachedCssWidth = 0;
    this.cachedCssHeight = 0;
  };

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

  notifyChange(reason?: 'document-text'): void {
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    for (const listener of this.changeListeners) {
      listener(reason);
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
    let previousToolMode = this.toolManager.getState().mode;
    this.unsubscribeToolState = this.toolManager.subscribe((state) => {
      if (state.mode === 'select' && previousToolMode !== 'select') this.drawingEngine.warmSelectionBacking?.();
      else if (state.mode !== 'select' && previousToolMode === 'select') this.drawingEngine.releaseSelectionSurfaces?.();
      if (state.mode !== 'select') {
        this.clearSelectionCursor();
        const selected = this.selectionEngine?.getSelectedElements?.() ?? [];
        const shouldClearSelection =
          state.mode === 'draw'
          || state.mode === 'erase'
          || state.mode === 'shape'
          || (state.mode === 'text' && !(
            selected.length === 1
            && selected[0]?.type === 'text'
          ));
        if (shouldClearSelection) {
          if (this.selectionDragMode === 'lasso') {
            this.cancelTransientAnimationFrames();
            this.drawingEngine.endLasso?.();
            this.selectionDragMode = 'none';
            this.lassoPoints = [];
            this.lassoStartPoint = null;
            this.isDrawing = false;
            this.strokeModeAtStart = null;
          }
          if (selected.length > 0) {
            this.selectionEngine.clearSelection?.();
            this.selectionEngine.flushPendingSelectionRedraw?.();
          }
        }
      }
      if ((this.holdSnapTimer !== null || this.holdSnapState !== null)
        && (state.mode !== 'draw' || (!state.straightLineRecognition && !state.roughShapeRecognition))) {
        this.clearHoldSnap(true);
      }
      previousToolMode = state.mode;
      if (state.mode !== 'draw' || state.drawingTool !== 'laser') {
        this.laserPointerActive = false;
        this.laserManager.clear();
      }
      if (this.rulerManager.setEnabled(state.rulerEnabled)) {
        if (!state.rulerEnabled) this.rulerDragMode = null;
        this.drawingEngine.redraw();
      }
      if (this.isPanning && !this.isPanningOverride && state.mode !== 'hand') this.finishPanning();
    });
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
    canvas.addEventListener('lostpointercapture', this.handleEraserCaptureLost);
    canvas.addEventListener('lostpointercapture', this.handlePanCaptureLost);
    if (typeof window !== 'undefined' && 'onpointerrawupdate' in window) {
      canvas.addEventListener('pointerrawupdate', this.handlePointerMove as EventListener);
    }
    // NOTE: `pointerleave` is deliberately NOT wired to handlePointerUp. Every gesture
    // start below calls setPointerCapture on this canvas, so `pointerup` is guaranteed
    // to be delivered here even when the button is released outside the element.
    // Ending the gesture on a boundary crossing only ever truncated live gestures.
    canvas.style.touchAction = 'none';
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', this.cancelTransientInteraction);
      window.addEventListener('resize', this.clearCachedCanvasRect, { passive: true });
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  /** Detach event listeners. Call on unmount. */
  detach(): void {
    // Release ownership only after detach has finished: idle may synchronously
    // activate another page and re-enter engine/input cleanup.
    const releaseNavigation = this.releasePanNavigation;
    this.releasePanNavigation = null;
    this.finishPanning();
    this.flushPendingErasing();
    this.setDrawingGestureActive(false);
    this.unsubscribeToolState?.();
    this.unsubscribeToolState = null;
    if (!this.canvas) {
      releaseNavigation?.();
      return;
    }
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('lostpointercapture', this.handleEraserCaptureLost);
    this.canvas.removeEventListener('lostpointercapture', this.handlePanCaptureLost);
    if (typeof window !== 'undefined' && 'onpointerrawupdate' in window) {
      this.canvas.removeEventListener('pointerrawupdate', this.handlePointerMove as EventListener);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', this.cancelTransientInteraction);
      window.removeEventListener('resize', this.clearCachedCanvasRect);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.clearSelectionCursor();
    this.rulerDragMode = null;
    this.laserPointerActive = false;
    this.laserManager.clear();
    this.clearHoldSnap(false);
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
    this.cancelTransientAnimationFrames();
    this.clearTransientTextDomPositions();
    this.drawingEngine?.endLasso?.();
    setSelectionGestureActive(this, false);
    this.selectionDragMode = 'none';
    this.lassoPoints = [];
    this.lassoStartPoint = null;
    this.laserManager.clear();
    this.canvas = null;
    releaseNavigation?.();
  }

  private clearSelectionCursor(): void {
    if (this.canvas && SELECTION_CURSORS.has(this.canvas.style.cursor)) {
      this.canvas.style.removeProperty('cursor');
    }
  }

  // ---- Event Handlers (bound as arrow functions for stable references) ----

  private handlePointerDown = (e: PointerEvent): void => {
    if (this.isPanning) return;
    if (this.inkSamples) return;
    if (this.eraserGesture) return;
    const toolState = this.toolManager.getState();
    // A deferred preview handoff leaves the live canvas blank until the
    // preview finishes. The first real gesture needs pixels now; repaint
    // synchronously rather than selecting/erasing against an empty surface.
    if (['draw', 'erase', 'shape', 'select', 'text'].includes(toolState.mode)) {
      this.drawingEngine.ensureSurfaceReadyForInteraction?.();
    }
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
    if (!e.shiftKey && e.button === 0 && now - this.lastClickTime < 300
      && this.lastClickPoint && this.lastClickPointerType === e.pointerType
      && Math.hypot(e.clientX - this.lastClickPoint.x, e.clientY - this.lastClickPoint.y) <= 6
      && this.selectionEngine.getSelectedElements().length <= 1) {
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
    this.lastClickTime = e.shiftKey ? 0 : now;
    this.lastClickPoint = { x: e.clientX, y: e.clientY };
    this.lastClickPointerType = e.pointerType;

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
      if (e.button === 0) {
        this.cacheCanvasRectForGesture();
        this.startLaser(e);
      }
      return;
    }

    if (['draw', 'shape', 'text'].includes(toolState.mode) && !this.drawingEngine.canEditActiveLayer()) return;

    this.cacheCanvasRectForGesture();

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
    // Hand navigation and selection transforms need the display-paced move stream. Keep raw/coalesced
    // samples for ink, erasing, ruler and laser interactions below.
    if ((this.isPanning || this.selectionDragMode === 'transform' || this.selectionDragMode === 'lasso') && e.type === 'pointerrawupdate') return;
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
    if (this.isPanning) {
      if (e.pointerId === this.panPointerId) this.finishPanning();
      return;
    }
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
    }
    this.clearCachedCanvasRect();
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.cancelTransientInteraction();
  };

  private handleEraserCaptureLost = (e: PointerEvent): void => {
    if (this.eraserGesture?.pointerId === e.pointerId) this.flushPendingErasing('lost-capture');
  };

  private handlePanCaptureLost = (e: PointerEvent): void => {
    if (e.pointerId === this.panPointerId) this.finishPanning();
  };

  private cancelTransientInteraction = (): void => {
    const wasErasing = this.eraserGesture !== null;
    this.flushPendingErasing('cancel');
    const cancelledContext = this.strokeContextAtStart;
    const wasDrawingInk = this.isDrawing && this.strokeModeAtStart === 'draw';
    if (wasDrawingInk && (this.holdTimerFired || this.holdSnapState !== null || this.strokePathLenCss >= HOLD_SNAP_MIN_PATH_CSS_PX)) {
      if (this.holdSnapAnchor) {
        this.holdElapsedMs = Math.max(this.holdElapsedMs, Math.max(0, performance.now() - this.holdSnapAnchor.sincePerfMs));
        this.holdMaxDriftCss = Math.max(this.holdMaxDriftCss, this.holdSnapAnchor.maxDriftCss);
      }
      this.recordShapeDiag('cancelled', cancelledContext, this.toolManager.getState(), false);
    }

    this.clearHoldSnap(false);
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
    this.cancelTransientAnimationFrames();
    this.clearTransientTextDomPositions();
    this.selectionDragMode = 'none';
    this.lassoPoints = [];
    this.lassoStartPoint = null;
    this.rulerDragMode = null;
    this.laserPointerActive = false;
    this.laserManager.clear();
    if (!wasErasing) this.drawingEngine.redraw();

    if (wasDrawingInk && cancelledContext?.recognitionEligible) {
      this.notifyStrokeLifecycle({
        type: 'cancel',
        instrument: cancelledContext.tool as 'pen' | 'pencil',
      });
    }
    this.finishPanning();
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
    this.clearCachedCanvasRect();
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
    const bodyId = this.textManager.getDocumentBodyId();
    if (bodyId) {
      document.dispatchEvent(new CustomEvent('panvas:focus-text', { detail: { id: bodyId } }));
      return;
    }
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
          content: [],
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
    this.isDrawing = true;
    this.strokeModeAtStart = 'select';
    const point = this.getCanvasPoint(e);
    this.lassoPoints = [];
    this.lassoStartPoint = null;
    this.lassoShape = 'freeform';

    // getHandleAt() and selectAt() preserve the existing handle, active-bounds,
    // click-to-select, and Shift+click behavior. Only a genuine empty-canvas hit starts
    // lasso collection. Toolbar/React selection notifications are coalesced to
    // the next frame so dense-page hit testing and drag setup stay in one task.
    // A freeform region is itself a move handle: dragging from inside the drawn
    // selection (or on its outline) moves the selected content. Shift keeps the
    // add-to-selection behavior, and resize/rotate handles are checked first.
    if (!e.shiftKey && this.selectionEngine.shouldDragFreeformRegion(point.x, point.y)) {
      this.selectionDragMode = 'transform';
      setSelectionGestureActive(this, true);
      this.selectionEngine.startDrag(point.x, point.y);
      return;
    }
    const selectGesture = () => {
      const handleHit = this.selectionEngine.getHandleAt(point.x, point.y);
      const hit = Boolean(handleHit)
        || this.selectionEngine.selectAt(point.x, point.y, e.shiftKey, Boolean(handleHit));
      if (hit) {
        this.selectionDragMode = 'transform';
        setSelectionGestureActive(this, true);
        this.selectionEngine.startDrag(point.x, point.y);
      }
      return hit;
    };
    const hitSelectionOrElement = typeof this.selectionEngine.withDeferredSelectionNotifications === 'function'
      ? this.selectionEngine.withDeferredSelectionNotifications(selectGesture)
      : selectGesture();

    if (hitSelectionOrElement) {
      return;
    }

    this.selectionDragMode = 'lasso';
    setSelectionGestureActive(this, true);
    this.lassoShape = this.toolManager.getState().selectionShape === 'rectangle' ? 'rectangle' : 'freeform';
    this.lassoStartPoint = point;
    this.lassoPoints = [point];
    this.selectionEngine.flushPendingSelectionRedraw?.();
    this.drawingEngine.startLasso?.();
    this.drawingEngine.renderLasso(this.lassoPoints);
  }

  /** Rectangular lasso preview/selection polygon; Shift constrains to a square. */
  private rectangleLassoLoop(current: StrokePoint, shiftKey: boolean): StrokePoint[] {
    const start = this.lassoStartPoint ?? current;
    let x1 = current.x, y1 = current.y;
    if (shiftKey) {
      const dx = current.x - start.x, dy = current.y - start.y;
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      x1 = start.x + Math.sign(dx || 1) * size;
      y1 = start.y + Math.sign(dy || 1) * size;
    }
    return [
      { ...start },
      { x: x1, y: start.y, pressure: current.pressure, t: current.t },
      { x: x1, y: y1, pressure: current.pressure, t: current.t },
      { x: start.x, y: y1, pressure: current.pressure, t: current.t },
      { ...start },
    ];
  }

  private continueSelection(e: PointerEvent): void {
    const point = this.getCanvasPoint(e);
    if (this.selectionDragMode === 'lasso') {
      if (this.lassoShape === 'rectangle') {
        this.lassoPoints = this.rectangleLassoLoop(point, e.shiftKey);
      } else {
        this.lassoPoints.push(point);
      }
      if (typeof requestAnimationFrame === 'function') {
        if (this.lassoRafId === null) {
          this.lassoRafId = requestAnimationFrame(() => {
            this.lassoRafId = null;
            if (this.selectionDragMode === 'lasso') {
              this.drawingEngine.renderLasso(this.lassoPoints);
            }
          });
        }
      } else {
        this.drawingEngine.renderLasso(this.lassoPoints);
      }
      return;
    }

    if (this.selectionDragMode !== 'transform') return;
    this.pendingSelectionPoint = point;
    if (typeof requestAnimationFrame === 'function') {
      if (this.selectionRafId === null) {
        this.selectionRafId = requestAnimationFrame(() => {
          this.selectionRafId = null;
          if (this.selectionDragMode === 'transform' && this.pendingSelectionPoint) {
            const pt = this.pendingSelectionPoint;
            this.pendingSelectionPoint = null;
            this.selectionEngine.dragTo(pt.x, pt.y);
            this.updateTransientTextDomPositions();
          }
        });
      }
    } else {
      // Direct fallback for headless test environments
      this.selectionEngine.dragTo(point.x, point.y);
      this.updateTransientTextDomPositions();
    }
  }

  private finishSelection(e: PointerEvent): void {
    this.cancelTransientAnimationFrames();
    const point = this.getCanvasPoint(e);
    this.isDrawing = false;
    this.strokeModeAtStart = null;

    if (this.selectionDragMode === 'lasso') {
      if (this.lassoShape === 'rectangle') {
        this.lassoPoints = this.rectangleLassoLoop(point, e.shiftKey);
      } else {
        this.lassoPoints.push(point);
      }
      const completedLoop = this.lassoPoints;
      this.lassoPoints = [];
      this.lassoStartPoint = null;
      this.selectionDragMode = 'none';
      setSelectionGestureActive(this, false);
      this.drawingEngine.endLasso?.();
      if (completedLoop.length >= 3) {
        // Freeform selections keep their drawn boundary as the visible region;
        // rectangle selections are fully represented by the transform frame.
        this.selectionEngine.selectWithinLoop(
          completedLoop,
          false,
          this.lassoShape === 'freeform' ? completedLoop : null,
        );
      }
      // selectWithinLoop intentionally does not redraw when nothing is enclosed; always
      // redraw here so the transient lasso disappears for both hit and miss outcomes.
      this.drawingEngine.redraw();
      return;
    }

    if (this.selectionDragMode === 'transform') {
      this.selectionEngine.dragTo(point.x, point.y);
      this.clearTransientTextDomPositions();
      this.selectionDragMode = 'none';
      setSelectionGestureActive(this, false);
      const moved = this.selectionEngine.finishDrag(point.x, point.y);
      if (moved) {
        this.notifyChange();
      }
      return;
    }

    setSelectionGestureActive(this, false);
    this.selectionDragMode = 'none';
  }

  private updateTransientTextDomPositions(): void {
    const selected = this.selectionEngine?.getSelectedElements?.() ?? [];
    for (const el of selected) {
      if (el.type === 'text') {
        const domNode = this.canvas?.parentElement?.querySelector(`[data-text-object-id="${el.id}"]`) as HTMLElement | null;
        if (domNode) {
          const scale = this.viewport.getState().scale;
          const orig = this.selectionEngine?.getOriginalPosition?.(el.id);
          const current = this.textManager?.getTexts?.()?.find(t => t.id === el.id);
          if (orig && current) {
            if (!domNode.hasAttribute('data-orig-transform')) {
              domNode.setAttribute('data-orig-transform', domNode.style.transform);
            }
            const shiftX = (current.x - orig.x) * scale;
            const shiftY = (current.y - orig.y) * scale;
            const rotation = current.rotation ?? 0;
            domNode.style.transform = `translate(${shiftX}px, ${shiftY}px) scale(${scale}) rotate(${rotation}deg)`;
          }
        }
      }
    }
  }

  private clearTransientTextDomPositions(): void {
    const selected = this.selectionEngine?.getSelectedElements?.() ?? [];
    for (const el of selected) {
      if (el.type === 'text') {
        const domNode = this.canvas?.parentElement?.querySelector(`[data-text-object-id="${el.id}"]`) as HTMLElement | null;
        if (domNode) {
          const orig = domNode.getAttribute('data-orig-transform');
          if (orig !== null) {
            domNode.style.transform = orig;
            domNode.removeAttribute('data-orig-transform');
          } else {
            domNode.style.transform = '';
          }
        }
      }
    }
  }

  // ---- Panning ----
  //
  // Panning ownership is split deliberately. In the notebook, the `.notebook-viewport`
  // scroll container owns mouse/pen panning (see NotebookRenderer) because a hand drag
  // must work when it starts on an inter-page gap, a side margin, or a non-focused page
  // — none of which are this canvas. Two cases still belong to the canvas:
  //   * PDF annotations pan their native document scroller.
  //   * Touch, because `touch-action: none` (set in attach) suppresses native scrolling
  //     on this canvas, while the viewport controller leaves touch to native scrolling.
  private isPanning = false;
  private panPointerId: number | null = null;
  private releasePanNavigation: (() => void) | null = null;
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
    this.releasePanNavigation = this.navigationGestures.begin();
    this.panPointerId = e.pointerId;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      // Ignore DOMException if the pointer is already gone
    }
    this.isPanning = true;
    this.strokeModeAtStart = 'hand';
    this.panStartX = e.clientX;
    this.panStartY = e.clientY;

    this.panScrollTarget = this.canvas.closest('.notebook-viewport, [data-panvas-scroll-viewport]');
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
    if (!this.isPanning || e.pointerId !== this.panPointerId) return;

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

  private finishPanning(): void {
    if (!this.isPanning && !this.releasePanNavigation) return;
    const pointerId = this.panPointerId;
    const releaseNavigation = this.releasePanNavigation;
    this.releasePanNavigation = null;
    this.panPointerId = null;
    this.isPanning = false;
    this.isPanningOverride = false;
    this.strokeModeAtStart = null;
    this.panScrollTarget = null;
    if (pointerId !== null) {
      try { this.canvas?.releasePointerCapture(pointerId); } catch { /* Capture already lost. */ }
    }
    releaseNavigation?.();
  }

  // ---- Drawing ----

  private startLaser(e: PointerEvent): void {
    if (this.canvas) this.canvas.setPointerCapture(e.pointerId);
    this.laserPointerActive = true;
    this.strokeStartPerfMs = performance.now();
    this.laserManager.startStroke();
    this.laserManager.addPoint(this.getCanvasPoint(e));
  }

  private continueLaser(e: PointerEvent): void {
    if (!this.laserPointerActive) return;
    this.laserManager.addPoint(this.getCanvasPoint(e));
  }

  private finishLaser(e: PointerEvent): void {
    this.continueLaser(e);
    this.laserPointerActive = false;
    this.clearCachedCanvasRect();
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

    const useCache = Boolean(this.cachedCanvasRect) && (
      this.isDrawing
      || this.selectionDragMode !== 'none'
      || Boolean(this.eraserGesture)
      || this.rulerDragMode !== null
      || this.laserPointerActive
    );
    const rect = useCache ? this.cachedCanvasRect! : this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0, pressure: 0.5, t: 0 };

    // Base document CSS dimensions of the canvas
    const fallbackCss = (useCache && this.cachedCssWidth > 0 && this.cachedCssHeight > 0)
      ? null
      : this.getCanvasCssSize(this.canvas);
    const cssWidth = (useCache && this.cachedCssWidth > 0) ? this.cachedCssWidth : fallbackCss!.width;
    const cssHeight = (useCache && this.cachedCssHeight > 0) ? this.cachedCssHeight : fallbackCss!.height;

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
      t: Math.max(0, performance.now() - this.strokeStartPerfMs),
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
      if (!this.cachedCanvasRect) this.cacheCanvasRectForGesture();
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
    this.strokeStartPerfMs = performance.now();
    this.strokePointerType = e.pointerType || 'mouse';
    this.strokeLastClientX = e.clientX;
    this.strokeLastClientY = e.clientY;
    this.strokePathLenCss = 0;
    this.holdTimerFired = false;
    this.holdElapsedMs = 0;
    this.holdMaxDriftCss = 0;
    this.holdLastAttemptPointCount = -1;
    this.lastStraightLineDiag = null;
    this.lastRoughShapeDiag = null;
    this.inkInputFilter.reset();
    this.inkCenterline.reset();
    this.inkRulerSnapped = false;
    this.inkFilterCheckpoints.length = 0;
    this.liveRevisionFrom = Infinity;
    const origin = this.viewport.pageToCanvas(0, 0), axis = this.viewport.pageToCanvas(1, 0);
    this.inkScreenScale = this.cachedCanvasRect && this.cachedCssWidth && this.cachedCssHeight
      ? Math.hypot((axis.x - origin.x) * this.cachedCanvasRect.width / this.cachedCssWidth,
        (axis.y - origin.y) * this.cachedCanvasRect.height / this.cachedCssHeight) : 1;
    this.currentPoints = [];
    this.inkRawPoints = [];
    this.clearHoldSnap(false);
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
      this.consumeLiveRevisionFrom(),
    );
    if (this.strokeContextAtStart.recognitionEligible) {
      this.notifyStrokeLifecycle({
        type: 'start',
        instrument: this.strokeContextAtStart.tool as 'pen' | 'pencil',
      });
    }
  }

  private canHoldSnap(
    toolState: ReturnType<ToolManager['getState']>,
    strokeContext: DrawingStrokeContext | null,
  ): boolean {
    if (this.strokeModeAtStart !== 'draw' || !strokeContext || strokeContext.recognitionEligible || this.inkRulerSnapped) {
      return false;
    }
    const shapeEligibleTool = strokeContext.tool === 'pen' || strokeContext.tool === 'pencil' || strokeContext.tool === 'marker';
    return (toolState.straightLineRecognition && shapeEligibleTool)
      || (toolState.roughShapeRecognition && shapeEligibleTool);
  }

  private clearHoldSnap(clearPreview = false): void {
    if (this.holdSnapTimer !== null) {
      clearTimeout(this.holdSnapTimer);
      this.holdSnapTimer = null;
    }
    if (this.holdSnapPreviewRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.holdSnapPreviewRafId);
      this.holdSnapPreviewRafId = null;
    }
    this.pendingHoldSnapPreview = null;
    this.holdSnapAnchor = null;
    this.holdLastAttemptPointCount = -1;
    const hadShapePreview = this.holdSnapState !== null;
    this.holdSnapState = null;
    if (clearPreview && hadShapePreview) {
      this.drawingEngine?.clearLiveShapePreview?.();
    }
  }

  private scheduleHoldSnapPreview(render: () => void): void {
    if (typeof requestAnimationFrame !== 'function') {
      render();
      return;
    }
    this.pendingHoldSnapPreview = render;
    if (this.holdSnapPreviewRafId !== null) return;
    this.holdSnapPreviewRafId = requestAnimationFrame(() => {
      this.holdSnapPreviewRafId = null;
      const job = this.pendingHoldSnapPreview;
      this.pendingHoldSnapPreview = null;
      if (job && this.holdSnapState) job();
    });
  }

  private scheduleHoldSnapTimer(delayMs: number): void {
    if (this.holdSnapTimer !== null) {
      clearTimeout(this.holdSnapTimer);
      this.holdSnapTimer = null;
    }
    this.holdSnapTimer = setTimeout(() => {
      this.onHoldSnapTimer();
    }, delayMs);
  }

  private onHoldSnapTimer(): void {
    this.holdSnapTimer = null;
    if (!this.isDrawing || this.holdSnapState) return;
    if (this.strokePathLenCss < HOLD_SNAP_MIN_PATH_CSS_PX) return;
    this.holdTimerFired = true;
    const now = performance.now();
    this.holdElapsedMs = this.holdSnapAnchor
      ? Math.max(this.holdElapsedMs, now - this.holdSnapAnchor.sincePerfMs)
      : Math.max(this.holdElapsedMs, HOLD_SNAP_DELAY_MS);
    this.tryHoldSnap();
    if (!this.holdSnapState) {
      this.holdLastAttemptPointCount = this.inkRawPoints.length;
    }
  }

  private recordShapeDiag(
    finalOutcome: ShapeRecognitionDiagnostic['finalOutcome'],
    strokeContext: DrawingStrokeContext | null,
    toolState: ReturnType<ToolManager['getState']>,
    circleSelectIntercepted = false,
  ): void {
    if (typeof window === 'undefined') return;
    const now = performance.now();
    const anchorElapsed = this.holdSnapAnchor ? Math.max(0, now - this.holdSnapAnchor.sincePerfMs) : 0;
    const holdElapsedMs = Math.round(Math.max(this.holdElapsedMs, anchorElapsed) * 10) / 10;
    const maxHoldDriftCss = Math.round(
      Math.max(this.holdMaxDriftCss, this.holdSnapAnchor?.maxDriftCss ?? 0) * 100,
    ) / 100;

    let rejectReason: string | null = null;
    if (finalOutcome === 'snapped-line' || finalOutcome === 'snapped-shape') {
      rejectReason = null;
    } else if (finalOutcome === 'circle-selected') {
      rejectReason = 'circle-to-select';
    } else if (finalOutcome === 'scribble-erased') {
      rejectReason = 'scribble-to-erase';
    } else if (finalOutcome === 'cancelled') {
      rejectReason = 'pointer-cancelled';
    } else if (!strokeContext) {
      rejectReason = 'missing-stroke-context';
    } else if (strokeContext.recognitionEligible) {
      rejectReason = 'handwriting-mode';
    } else if (this.inkRulerSnapped) {
      rejectReason = 'ruler-snapped';
    } else if (!(strokeContext.tool === 'pen' || strokeContext.tool === 'pencil' || strokeContext.tool === 'marker')) {
      rejectReason = 'tool-ineligible';
    } else if (!toolState.straightLineRecognition && !toolState.roughShapeRecognition) {
      rejectReason = 'toggles-off';
    } else if (this.strokePathLenCss < HOLD_SNAP_MIN_PATH_CSS_PX) {
      rejectReason = 'path-too-short';
    } else if (!this.holdTimerFired) {
      rejectReason = 'not-held';
    } else {
      rejectReason = 'geometry-rejected';
    }

    const entry: ShapeRecognitionDiagnostic = {
      ts: Date.now(),
      pointerType: this.strokePointerType,
      tool: strokeContext?.tool ?? toolState.drawingTool,
      layout: this.layoutModeGetter(),
      zoom: Math.round(this.inkScreenScale * 1000) / 1000,
      toggles: {
        scribbleToErase: toolState.scribbleToErase,
        circleToSelect: toolState.circleToSelect,
        straightLineRecognition: toolState.straightLineRecognition,
        snapRecognizedLines: toolState.snapRecognizedLines,
        roughShapeRecognition: toolState.roughShapeRecognition,
        snapRecognizedShapes: toolState.snapRecognizedShapes,
        rulerEnabled: toolState.rulerEnabled,
        handwritingToTextEnabled: toolState.handwritingToTextEnabled,
      },
      pointCount: this.inkRawPoints.length,
      pathLenCss: Math.round(this.strokePathLenCss * 10) / 10,
      holdTimerFired: this.holdTimerFired,
      holdElapsedMs,
      maxHoldDriftCss,
      straightLineResult: this.lastStraightLineDiag,
      roughShapeResult: this.lastRoughShapeDiag,
      circleSelectIntercepted,
      finalOutcome,
      rejectReason,
    };

    const target = window as unknown as { __panvasShapeDiag?: ShapeRecognitionDiagnostic[] };
    const ring = Array.isArray(target.__panvasShapeDiag) ? target.__panvasShapeDiag : [];
    ring.push(entry);
    if (ring.length > SHAPE_DIAG_MAX_ENTRIES) {
      ring.splice(0, ring.length - SHAPE_DIAG_MAX_ENTRIES);
    }
    target.__panvasShapeDiag = ring;
  }

  private resolveSnappedStrokeWidth(strokeContext: DrawingStrokeContext, points: ReadonlyArray<StrokePoint>): number {
    if (strokeContext.tool === 'marker') {
      return Math.max(4, strokeContext.thickness * 3);
    }
    // Use the median pressure of the moving stroke (excluding trailing stationary hold pressure spikes)
    // so snapped shapes match the drawn Classic Pen / inkFamily stroke width 1:1.
    let medianPressure = 0.5;
    if (strokeContext.pressureSensitivity && points.length > 0) {
      const end = points.length >= 12 ? Math.max(4, Math.floor(points.length * 0.88)) : points.length;
      const pressures: number[] = [];
      for (let i = 0; i < end; i += 1) {
        const p = points[i].pressure;
        if (Number.isFinite(p) && p > 0) pressures.push(p);
      }
      if (pressures.length > 0) {
        pressures.sort((a, b) => a - b);
        medianPressure = pressures[Math.floor(pressures.length / 2)];
      }
    }
    if (strokeContext.tool === 'pen' && strokeContext.inkFamily) {
      return Math.max(1, inkWidthAt(strokeContext.inkFamily, {
        pressure: medianPressure,
        direction: 0,
        thickness: strokeContext.thickness,
        distance: 100,
        length: 200,
      }));
    }
    return Math.max(1, strokeContext.thickness * medianPressure * 2);
  }

  private tryHoldSnap(): void {
    if (!this.isDrawing || this.holdSnapState) return;
    const toolState = this.toolManager.getState();
    const strokeContext = this.strokeContextAtStart;
    if (!this.canHoldSnap(toolState, strokeContext) || !strokeContext) return;
    const shapeEligibleTool = strokeContext.tool === 'pen' || strokeContext.tool === 'pencil' || strokeContext.tool === 'marker';
    const shapeStrokeWidth = this.resolveSnappedStrokeWidth(strokeContext, this.inkRawPoints);
    const screenScale = Math.max(0.1, this.inkScreenScale);
    const minPageDist = 8 / screenScale;

    const line = toolState.straightLineRecognition && shapeEligibleTool
      ? recognizeStraightLine(this.inkRawPoints, toolState.snapRecognizedLines, this.inkScreenScale, { deliberateHold: true })
      : null;
    this.lastStraightLineDiag = line ? {
      isLine: line.isLine,
      length: Math.round(line.length * 10) / 10,
      efficiency: Math.round(line.efficiency * 1000) / 1000,
      maxDeviation: Math.round(line.maxDeviation * 100) / 100,
      snappedAngle: line.snappedAngle !== null ? Math.round((line.snappedAngle * 180) / Math.PI) : null,
    } : null;
    if (line?.isLine && line.points.length >= 2) {
      const start = { ...line.points[0] };
      const end = { ...line.points[line.points.length - 1] };
      const shape: Shape = {
        id: generateId('shp'),
        type: 'shape',
        shapeType: 'line',
        lineStyle: toolState.lineStyle,
        x: start.x,
        y: start.y,
        width: end.x - start.x,
        height: end.y - start.y,
        color: strokeContext.color,
        strokeWidth: shapeStrokeWidth,
        fill: null,
        rotation: 0,
        opacity: strokeContext.opacity,
        createdAt: Date.now(),
      };
      this.holdSnapState = {
        kind: 'line',
        shape,
        start,
        end,
        snappedAngle: line.snappedAngle,
        adjustEngaged: false,
      };
      if (typeof this.drawingEngine.renderLiveShapePreview === 'function') {
        this.drawingEngine.renderLiveShapePreview(shape);
      } else {
        this.drawingEngine.renderLiveStroke(
          [start, end],
          strokeContext.tool,
          strokeContext.color,
          strokeContext.thickness,
          strokeContext.opacity,
          strokeContext.strokePattern,
          strokeContext.inkFamily,
          end,
          0,
        );
      }
      return;
    }

    const arrow = (toolState.roughShapeRecognition || toolState.straightLineRecognition) && shapeEligibleTool
      ? recognizeArrowGesture(this.inkRawPoints, toolState.snapRecognizedLines, this.inkScreenScale, { deliberateHold: true })
      : null;
    if (arrow?.isArrow && arrow.points && arrow.points.length >= 2) {
      const start = { ...arrow.points[0] };
      const end = { ...arrow.points[arrow.points.length - 1] };
      const shape: Shape = {
        id: generateId('shp'),
        type: 'shape',
        shapeType: arrow.shapeType,
        lineStyle: toolState.lineStyle,
        x: start.x,
        y: start.y,
        width: end.x - start.x,
        height: end.y - start.y,
        color: strokeContext.color,
        strokeWidth: shapeStrokeWidth,
        fill: null,
        rotation: 0,
        opacity: strokeContext.opacity,
        createdAt: Date.now(),
      };
      this.holdSnapState = {
        kind: 'line',
        shape,
        start,
        end,
        snappedAngle: arrow.snappedAngle,
        adjustEngaged: false,
      };
      if (typeof this.drawingEngine.renderLiveShapePreview === 'function') {
        this.drawingEngine.renderLiveShapePreview(shape);
      } else {
        this.drawingEngine.renderLiveStroke(
          [start, end],
          strokeContext.tool,
          strokeContext.color,
          strokeContext.thickness,
          strokeContext.opacity,
          strokeContext.strokePattern,
          strokeContext.inkFamily,
          end,
          0,
        );
      }
      return;
    }

    const recognized = toolState.roughShapeRecognition && shapeEligibleTool
      ? recognizeRoughShape(this.inkRawPoints, toolState.snapRecognizedShapes, this.inkScreenScale, { deliberateHold: true })
      : null;
    this.lastRoughShapeDiag = recognized ? {
      isShape: recognized.isShape,
      shapeType: recognized.shapeType,
      width: Math.round(recognized.width * 10) / 10,
      height: Math.round(recognized.height * 10) / 10,
      rotation: Math.round(recognized.rotation * 10) / 10,
    } : null;
    if (recognized?.isShape && recognized.shapeType) {
      const shape: Shape = {
        id: generateId('shp'),
        type: 'shape',
        shapeType: recognized.shapeType,
        x: recognized.x,
        y: recognized.y,
        width: recognized.width,
        height: recognized.height,
        color: strokeContext.color,
        strokeWidth: shapeStrokeWidth,
        fill: null,
        rotation: recognized.rotation,
        opacity: strokeContext.opacity,
        createdAt: Date.now(),
      };
      const center = { x: shape.x + shape.width * 0.5, y: shape.y + shape.height * 0.5 };
      const lastRaw = this.inkRawPoints[this.inkRawPoints.length - 1] ?? { x: center.x, y: center.y, pressure: 0.5, t: 0 };
      this.holdSnapState = {
        kind: 'shape',
        shape,
        center,
        initialPointerDistance: Math.max(minPageDist, Math.hypot(lastRaw.x - center.x, lastRaw.y - center.y)),
        initialPointerAngle: Math.atan2(lastRaw.y - center.y, lastRaw.x - center.x),
        initialWidth: shape.width,
        initialHeight: shape.height,
        initialRotation: shape.rotation,
        isCircle: Boolean(recognized.isCircle),
        adjustEngaged: false,
      };
      this.drawingEngine.renderLiveShapePreview?.(shape);
    }
  }

  private adjustHoldSnap(e: PointerEvent): void {
    const state = this.holdSnapState;
    const strokeContext = this.strokeContextAtStart;
    if (!state || !strokeContext) return;
    if (!state.adjustEngaged) {
      if (this.holdSnapAnchor && Math.hypot(e.clientX - this.holdSnapAnchor.clientX, e.clientY - this.holdSnapAnchor.clientY) <= HOLD_SNAP_JITTER_CSS_PX) {
        return;
      }
      state.adjustEngaged = true;
    }

    const pt = this.getCanvasPoint(e);
    const toolState = this.toolManager.getState();
    const invScale = 1 / Math.max(0.1, this.inkScreenScale);

    if (state.kind === 'line') {
      const dx = pt.x - state.start.x;
      const dy = pt.y - state.start.y;
      const length = Math.hypot(dx, dy);
      if (length >= 4 * invScale) {
        const rawAngle = Math.atan2(dy, dx);
        let finalAngle = rawAngle;
        let snappedAngle: number | null = null;
        if (toolState.snapRecognizedLines || e.shiftKey) {
          const step = e.shiftKey ? Math.PI / 12 : Math.PI / 4;
          const tol = e.shiftKey ? (7.5 * Math.PI) / 180 : (6 * Math.PI) / 180;
          const nearest = Math.round(rawAngle / step) * step;
          const diff = Math.abs(Math.atan2(Math.sin(rawAngle - nearest), Math.cos(rawAngle - nearest)));
          if (diff <= tol) {
            finalAngle = nearest;
            snappedAngle = nearest;
          }
        }
        const cos = Math.abs(Math.cos(finalAngle)) < 1e-12 ? 0 : Math.cos(finalAngle);
        const sin = Math.abs(Math.sin(finalAngle)) < 1e-12 ? 0 : Math.sin(finalAngle);
        state.end = {
          ...state.end,
          x: state.start.x + cos * length,
          y: state.start.y + sin * length,
          t: Math.max(0, performance.now() - this.strokeStartPerfMs),
        };
        state.snappedAngle = snappedAngle;
        state.shape.x = state.start.x;
        state.shape.y = state.start.y;
        state.shape.width = state.end.x - state.start.x;
        state.shape.height = state.end.y - state.start.y;
      }
      this.scheduleHoldSnapPreview(() => {
        if (typeof this.drawingEngine.renderLiveShapePreview === 'function') {
          this.drawingEngine.renderLiveShapePreview(state.shape);
        } else {
          this.drawingEngine.renderLiveStroke(
            [state.start, state.end],
            strokeContext.tool,
            strokeContext.color,
            strokeContext.thickness,
            strokeContext.opacity,
            strokeContext.strokePattern,
            strokeContext.inkFamily,
            state.end,
            0,
          );
        }
      });
      return;
    }

    const dx = pt.x - state.center.x;
    const dy = pt.y - state.center.y;
    const dist = Math.hypot(dx, dy);
    const scale = Math.max(0.2, Math.min(5, dist / Math.max(8 * invScale, state.initialPointerDistance)));
    const newWidth = Math.max(10 * invScale, state.initialWidth * scale);
    const newHeight = Math.max(10 * invScale, state.initialHeight * scale);
    state.shape.width = newWidth;
    state.shape.height = newHeight;
    state.shape.x = state.center.x - newWidth * 0.5;
    state.shape.y = state.center.y - newHeight * 0.5;

    if (!state.isCircle) {
      const deltaDeg = ((Math.atan2(dy, dx) - state.initialPointerAngle) * 180) / Math.PI;
      let rot = ((state.initialRotation + deltaDeg + 180) % 360 + 360) % 360 - 180;
      const nearest = Math.round(rot / 45) * 45;
      if (Math.abs(rot - nearest) <= 5) rot = nearest;
      if (rot === 180 || rot === -180) rot = 0;
      state.shape.rotation = rot;
    }
    this.scheduleHoldSnapPreview(() => {
      this.drawingEngine.renderLiveShapePreview?.(state.shape);
    });
  }

  private continueDrawing(e: PointerEvent): void {
    const startedAt = this.inkTrace ? performance.now() : 0;
    const strokeContext = this.strokeContextAtStart ?? resolveDrawingStrokeContext(this.toolManager.getState());
    if (this.holdSnapState) {
      if (this.ownsInkEvent(e)) this.adjustHoldSnap(e);
      this.traceInkTiming('pointerHandlerMs', startedAt);
      return;
    }
    const owned = this.ownsInkEvent(e);
    if (owned && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      this.strokePathLenCss += Math.hypot(e.clientX - this.strokeLastClientX, e.clientY - this.strokeLastClientY);
      this.strokeLastClientX = e.clientX;
      this.strokeLastClientY = e.clientY;
    }
    const accepted = this.acceptInkSamples(e);
    if (owned) {
      if (this.inkRulerSnapped) {
        this.clearHoldSnap(false);
      } else if (this.canHoldSnap(this.toolManager.getState(), strokeContext) && this.strokePathLenCss >= HOLD_SNAP_MIN_PATH_CSS_PX) {
        const now = performance.now();
        const anchor = this.holdSnapAnchor;
        const distFromAnchor = anchor ? Math.hypot(e.clientX - anchor.clientX, e.clientY - anchor.clientY) : Infinity;

        if (!anchor || distFromAnchor > HOLD_SNAP_JITTER_CSS_PX) {
          // Pointer genuinely moved away from previous anchor: move anchor and reschedule a fresh hold timer.
          this.holdSnapAnchor = { clientX: e.clientX, clientY: e.clientY, sincePerfMs: now, maxDriftCss: 0 };
          this.holdLastAttemptPointCount = -1;
          this.scheduleHoldSnapTimer(HOLD_SNAP_DELAY_MS);
        } else {
          // Within <= 14 CSS px of anchor: NEVER cancel/reset an active timer (handles both motionless mouse
          // holds and noisy 240-500Hz stylus holds). If a prior timer tick already fired and failed, cleanly
          // re-arm whenever new geometry arrives so a subsequent motionless hold can never lock out.
          if (distFromAnchor > anchor.maxDriftCss) anchor.maxDriftCss = distFromAnchor;
          if (anchor.maxDriftCss > this.holdMaxDriftCss) this.holdMaxDriftCss = anchor.maxDriftCss;

          if (this.holdSnapTimer === null) {
            if (this.inkRawPoints.length > this.holdLastAttemptPointCount) {
              this.scheduleHoldSnapTimer(HOLD_SNAP_RETRY_MS);
            }
          } else if (now - anchor.sincePerfMs >= HOLD_SNAP_DELAY_MS + 40) {
            // Backstop if high-rate input events delayed macrotask delivery past HOLD_SNAP_DELAY_MS.
            clearTimeout(this.holdSnapTimer);
            this.onHoldSnapTimer();
            if (this.holdSnapState) {
              this.traceInkTiming('pointerHandlerMs', startedAt);
              return;
            }
          }

          // Avoid bloating a pressure-spike ink blotch at the tip while the stylus dwells stationary waiting to snap.
          if (now - anchor.sincePerfMs >= 100) {
            const prev = this.currentPoints[this.currentPoints.length - 2];
            const curr = this.currentPoints[this.currentPoints.length - 1];
            if (prev && curr && Math.hypot(curr.x - prev.x, curr.y - prev.y) * Math.max(0.1, this.inkScreenScale) < 1.5) {
              curr.pressure = prev.pressure;
              this.traceInkTiming('pointerHandlerMs', startedAt);
              return;
            }
          }
        }
      }
    }
    if (!accepted) {
      this.traceInkTiming('pointerHandlerMs', startedAt);
      return;
    }
    const latestRawPoint = this.inkRawPoints[this.inkRawPoints.length - 1];
    const renderStartedAt = this.inkTrace ? performance.now() : 0;
    const predictedPoints = this.extractPredictedPoints(e, strokeContext);

    this.drawingEngine.renderLiveStroke(
      this.currentPoints,
      strokeContext.tool,
      strokeContext.color,
      strokeContext.thickness,
      strokeContext.opacity,
      strokeContext.strokePattern,
      strokeContext.inkFamily,
      latestRawPoint,
      this.consumeLiveRevisionFrom(),
      predictedPoints,
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

  /** Consume the geometry-revision start produced by the last acceptInkSamples. */
  private consumeLiveRevisionFrom(): number {
    const value = this.liveRevisionFrom;
    this.liveRevisionFrom = Infinity;
    return value;
  }

  /**
   * Extract at most 2 bounded ephemeral OS pointer-prediction samples (<= 24 CSS px
   * from the live tip). Disabled during hold-to-snap dwell, ruler snapping,
   * patterned strokes, and non-pen tools; NEVER persisted into stroke.points.
   */
  private extractPredictedPoints(
    e: PointerEvent,
    strokeContext: DrawingStrokeContext,
  ): readonly StrokePoint[] | undefined {
    this.predictedPointsScratch.length = 0;
    if (
      e.type === 'pointerrawupdate'
      || !this.isDrawing
      || this.strokeModeAtStart !== 'draw'
      || strokeContext.tool !== 'pen'
      || strokeContext.strokePattern !== 'solid'
      || this.inkRulerSnapped
      || this.holdSnapState !== null
      || this.currentPoints.length === 0
      || typeof e.getPredictedEvents !== 'function'
    ) {
      return undefined;
    }
    if (this.holdSnapAnchor && performance.now() - this.holdSnapAnchor.sincePerfMs >= 80) {
      return undefined;
    }
    const events = e.getPredictedEvents();
    if (!events || events.length === 0) return undefined;
    const cssScale = Math.max(0.1, this.inkScreenScale);
    let prevTip = this.currentPoints[this.currentPoints.length - 1];
    let cumCss = 0;
    const limit = Math.min(2, events.length);
    for (let i = 0; i < limit; i += 1) {
      const ev = events[i];
      if (!ev || !Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY)) break;
      const pt = this.getCanvasPoint(ev);
      const stepCss = Math.hypot(pt.x - prevTip.x, pt.y - prevTip.y) * cssScale;
      if (stepCss <= 0.5) continue;
      cumCss += stepCss;
      if (cumCss > 24) break;
      this.predictedPointsScratch.push(pt);
      prevTip = pt;
    }
    return this.predictedPointsScratch.length > 0 ? this.predictedPointsScratch : undefined;
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
    // The refilter restarts from the newest checkpoint at or before the insertion
    // point: earlier filtered geometry is final and must not move on screen, so
    // the visual revision is confined to the tail instead of the whole stroke.
    let fromIndex = oldLength;
    let revisedFrom = Infinity;
    if (result.rebuild) {
      const insertedAt = Number.isFinite(result.insertedAt) ? result.insertedAt : 0;
      const checkpoints = this.inkFilterCheckpoints;
      let cpIndex = -1;
      for (let c = checkpoints.length - 1; c >= 0; c--) {
        if (checkpoints[c].samples <= insertedAt) { cpIndex = c; break; }
      }
      if (cpIndex >= 0) {
        const checkpoint = checkpoints[cpIndex];
        checkpoints.length = cpIndex;
        this.inkInputFilter.restore(checkpoint.filter);
        this.inkCenterline.restore(checkpoint.centerline);
        this.inkRulerSnapped = checkpoint.rulerSnapped;
        this.currentPoints.length = checkpoint.filteredPoints;
        this.inkRawPoints.length = checkpoint.rawPoints;
        fromIndex = checkpoint.samples;
        revisedFrom = checkpoint.filteredPoints;
      } else {
        this.inkInputFilter.reset();
        this.inkCenterline.reset();
        this.inkRulerSnapped = false;
        this.currentPoints = [];
        this.inkRawPoints = [];
        fromIndex = 0;
        revisedFrom = 0;
      }
    }
    const context = this.strokeContextAtStart!;
    if (this.inkFilterCheckpoints.length >= InputManager.INK_CHECKPOINT_LIMIT) this.inkFilterCheckpoints.shift();
    this.inkFilterCheckpoints.push({
      samples: fromIndex,
      rawPoints: this.inkRawPoints.length,
      filteredPoints: this.currentPoints.length,
      filter: this.inkInputFilter.checkpoint(),
      centerline: this.inkCenterline.checkpoint(),
      rulerSnapped: this.inkRulerSnapped,
    });
    this.liveRevisionFrom = revisedFrom;
    for (let i = fromIndex; i < stream.samples.length; i++) {
      const sample = stream.samples[i];
      const rulerSnap = this.rulerManager.snapPointToEdge(this.getCanvasPoint(sample));
      const raw = rulerSnap.point;
      // Lift events commonly report zero pressure. Retain the last contact
      // pressure while preserving a distinct terminal XY/timestamp.
      if (e.type === 'pointerup' && sample.timeStamp === e.timeStamp && sample.pressure === 0
        && this.inkRawPoints.length) raw.pressure = this.inkRawPoints[this.inkRawPoints.length - 1].pressure;
      raw.t = sample.timeStamp - stream.startedAt;
      this.inkRawPoints.push(raw);
      // Ruler projection owns its edge and entry/exit joins. Restart freehand
      // filtering at the join so interpolation cannot bow across the ruler.
      const constrained = rulerSnap.isSnapped || this.inkRulerSnapped;
      if (constrained) { this.inkInputFilter.reset(); this.inkCenterline.reset(); }
      this.inkCenterline.append(this.inkInputFilter.push(raw, constrained ? 0 : context.stabilization, this.inkScreenScale), this.currentPoints, this.inkScreenScale);
      this.inkRulerSnapped = rulerSnap.isSnapped;
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
    this.inkFilterCheckpoints.length = 0;
    this.liveRevisionFrom = Infinity;
  }

  private finishDrawing(e: PointerEvent): void {
    const traceStartedAt = this.inkTrace ? performance.now() : 0;
    const snapped = this.holdSnapState;
    const toolStateAtFinish = this.toolManager.getState();
    // Capture anchor hold metrics before clearHoldSnap() resets holdSnapAnchor.
    if (this.holdSnapAnchor) {
      this.holdElapsedMs = Math.max(this.holdElapsedMs, Math.max(0, performance.now() - this.holdSnapAnchor.sincePerfMs));
      this.holdMaxDriftCss = Math.max(this.holdMaxDriftCss, this.holdSnapAnchor.maxDriftCss);
    }
    this.clearHoldSnap(false);
    if (e.type === 'pointerup' && !snapped) this.acceptInkSamples(e);
    const finalTip = this.inkRawPoints[this.inkRawPoints.length - 1];
    const filteredPoints = this.currentPoints;
    // Commit precisely the displayed path. The bounded filtered tip is already
    // visible; appending the physical tip only on lift would produce a snap.
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
    const strokeContext = this.strokeContextAtStart ?? resolveDrawingStrokeContext(toolStateAtFinish);
    this.strokeContextAtStart = null;
    try {
      if (e.type === 'pointercancel' && snapped) {
        this.recordShapeDiag('cancelled', strokeContext, toolStateAtFinish, false);
        this.currentPoints = [];
        this.drawingEngine.endLiveStroke?.();
        this.drawingEngine.redraw();
        gate0Profiler.finish(this.gate0InkGesture, { finishDrawingMs: finishStartedAt ? performance.now() - finishStartedAt : 0, cancelled: true });
        this.gate0InkGesture = null;
        return;
      }

      if (this.currentPoints.length < 1 && !snapped) {
        this.recordShapeDiag('cancelled', strokeContext, toolStateAtFinish, false);
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

      if (snapped) {
        this.recordShapeDiag(
          snapped.kind === 'line' && snapped.shape.shapeType === 'line' ? 'snapped-line' : 'snapped-shape',
          strokeContext,
          toolStateAtFinish,
          false,
        );
        this.drawingEngine.endLiveStroke?.();
        this.shapeManager.addShape(snapped.shape);
        this.drawingEngine.redraw();
        this.recordCommittedShape(snapped.shape, `Recognize ${snapped.shape.shapeType}`);
        this.currentPoints = [];
        gate0Profiler.finish(this.gate0InkGesture, {
          finishDrawingMs: finishStartedAt ? performance.now() - finishStartedAt : 0,
          committedPoints: 0,
          tool: strokeContext.tool,
        });
        this.gate0InkGesture = null;
        return;
      }

      const toolState = toolStateAtFinish;
      if (
        !snapped
        && !strokeContext.recognitionEligible
        && gestureMode === 'draw'
        && toolState.scribbleToErase
        && (strokeContext.tool === 'pen' || strokeContext.tool === 'pencil')
        && analyzeScribble(this.inkRawPoints, this.inkScreenScale).isScribble
      ) {
        const targets = findScribbleTargets(
          this.inkRawPoints,
          (x, y, radius) => this.drawingEngine.findStrokesNearPoint(x, y, radius),
          Math.max(3, strokeContext.thickness),
        );
        if (this.eraserEngine.eraseStrokeIds(targets)) {
          this.recordShapeDiag('scribble-erased', strokeContext, toolState, false);
          this.currentPoints = [];
          this.notifyChange();
          return;
        }
      }

      if (
        !snapped
        && !strokeContext.recognitionEligible
        && gestureMode === 'draw'
        && toolState.circleToSelect
        && (strokeContext.tool === 'pen' || strokeContext.tool === 'pencil')
        && analyzeCircleGesture(this.inkRawPoints, this.inkScreenScale).isCircle
        && this.selectionEngine.selectWithinLoop(this.inkRawPoints) > 0
      ) {
        this.recordShapeDiag('circle-selected', strokeContext, toolState, true);
        this.currentPoints = [];
        this.toolManager.setMode('select');
        return;
      }

      this.recordShapeDiag('freehand-stroke', strokeContext, toolState, false);
      const committedPoints = this.currentPoints;

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
          physicalPoints: this.inkRawPoints.map(point => ({ ...point })),
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
    this.clearCachedCanvasRect();
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
