import type { LineStyle } from './lineStyleGeometry.ts';
// ============================================
// Panvas — Tool Manager
// ============================================
// Single source of truth for active tool state.
// React components read from this; engine modules consume it.

import type { InkFamily, ToolState, NotebookMode, DrawingToolId, EraserMode, ShapeToolMode, StrokePattern, SelectionShape } from './drawingTypes.ts';
import { DEFAULT_TOOL_STATE } from './drawingTypes.ts';

export type ToolStateChangeListener = (state: Readonly<ToolState>) => void;

export interface DrawingStrokeContext {
  tool: DrawingToolId;
  color: string;
  thickness: number;
  opacity: number;
  recognitionEligible: boolean;
  pressureSensitivity: boolean;
  stabilization: number;
  strokePattern: StrokePattern;
  inkFamily?: InkFamily;
}

export function isHandwritingInputEligible(
  state: Readonly<Pick<ToolState, 'mode' | 'drawingTool' | 'handwritingToTextEnabled'>>,
): boolean {
  return state.handwritingToTextEnabled
    && state.mode === 'draw'
    && (state.drawingTool === 'pen' || state.drawingTool === 'pencil');
}

/** Resolves one immutable stroke style/eligibility snapshot from canonical engine state. */
export function resolveDrawingStrokeContext(toolState: Readonly<ToolState>): DrawingStrokeContext {
  const recognitionEligible = isHandwritingInputEligible(toolState);
  return {
    tool: toolState.drawingTool,
    color: recognitionEligible ? toolState.handwritingInkColor : toolState.color,
    thickness: recognitionEligible ? toolState.handwritingInkThickness : toolState.thickness,
    opacity: recognitionEligible ? 1 : toolState.opacity,
    recognitionEligible,
    pressureSensitivity: toolState.pressureSensitivity,
    stabilization: toolState.stabilization,
    strokePattern: toolState.strokePattern,
    inkFamily: toolState.drawingTool === 'pen' && !recognitionEligible ? toolState.inkFamily : undefined,
  };
}

export class ToolManager {
  private state: ToolState;

  // The object handed out by getState(). It is rebuilt only inside notify(), so its
  // identity is stable for exactly as long as the state is unchanged. Both halves of that
  // contract matter:
  //
  //   - Immutable: getState() used to return `this.state` itself, so every caller that
  //     stored the result (React useState seeds, InputManager's per-event `toolState`
  //     local) held an alias that the engine mutated underneath. A React mirror seeded
  //     that way can never be detected as stale, because the "old" value it compares
  //     against has already been rewritten in place.
  //   - Referentially stable: this is what makes the store safe to read through
  //     useSyncExternalStore, which re-reads the snapshot on every render and every
  //     resubscribe and bails out only on Object.is equality. Returning a fresh object
  //     per call would loop forever; returning a mutable one would never re-render.
  private snapshot: Readonly<ToolState>;

  private listeners: Set<ToolStateChangeListener> = new Set();

  constructor() {
    this.state = { ...DEFAULT_TOOL_STATE };
    this.snapshot = Object.freeze({ ...this.state });
  }

  /**
   * Current tool state. The returned object is frozen and its identity only changes when
   * the state actually changes, so it can be used directly as a useSyncExternalStore
   * snapshot.
   */
  getState(): Readonly<ToolState> {
    return this.snapshot;
  }

  /** Subscribe to tool state changes. Returns unsubscribe function. */
  subscribe(listener: ToolStateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.snapshot = Object.freeze({ ...this.state });
    const snapshot = this.snapshot;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  // ---- Mode ----

  setMode(mode: NotebookMode): void {
    // Unlike every other setter, this one can legitimately be a no-op — and it is the only
    // setter a user can invoke on an already-active value (clicking the highlighted tool).
    // While consumers kept their own mirrors fed only by change events, that made any
    // divergence permanent: the one action that would have repaired the UI was precisely
    // the one that emitted nothing. Subscribers now re-read getState() on every render, so
    // suppressing the redundant notification is a pure render-count optimisation and can
    // no longer latch a stale mirror.
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.notify();
  }

  // ---- Drawing Tool ----

  setDrawingTool(tool: DrawingToolId): void {
    this.state.drawingTool = tool;
    this.state.mode = 'draw';
    this.notify();
  }

  /** Independent real-time recognition mode; never changes the selected instrument. */
  setHandwritingToTextEnabled(enabled: boolean): void {
    if (this.state.handwritingToTextEnabled === enabled) return;
    this.state.handwritingToTextEnabled = enabled;
    this.notify();
  }

  toggleHandwritingToText(): void {
    this.setHandwritingToTextEnabled(!this.state.handwritingToTextEnabled);
  }

  /** Stores the temporary handwriting style without mutating Pen/Pencil presets. */
  setHandwritingInkStyle(color: string, thickness: number): void {
    const nextColor = /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_TOOL_STATE.handwritingInkColor;
    const nextThickness = Math.max(0.5, Math.min(20, thickness));
    if (
      this.state.handwritingInkColor === nextColor
      && this.state.handwritingInkThickness === nextThickness
    ) return;
    this.state.handwritingInkColor = nextColor;
    this.state.handwritingInkThickness = nextThickness;
    this.notify();
  }

  // ---- Eraser ----

  setEraserMode(mode: EraserMode): void {
    this.state.eraserMode = mode;
    this.state.mode = 'erase';
    this.notify();
  }

  // ---- Shape ----

  setShapeTool(shape: ShapeToolMode): void {
    this.state.shapeTool = shape;
    this.state.mode = 'shape';
    this.notify();
  }

  setShapeFillEnabled(enabled: boolean): void {
    this.state.shapeFillEnabled = enabled;
    this.notify();
  }

  // ---- Ink Properties ----

  setColor(color: string): void {
    this.state.color = color;
    this.notify();
  }

  setThickness(thickness: number): void {
    this.state.thickness = Math.max(0.5, Math.min(50, thickness));
    this.notify();
  }

  setOpacity(opacity: number): void {
    this.state.opacity = Math.max(0, Math.min(1, opacity));
    this.notify();
  }

  setPressureSensitivity(enabled: boolean): void {
    this.state.pressureSensitivity = enabled;
    this.notify();
  }

  setLineStyle(style: LineStyle): void { this.state.lineStyle = style; this.notify(); }

  setInkFamily(family?: InkFamily): void {
    this.state.inkFamily = family;
    this.notify();
  }

  setStrokePattern(pattern: StrokePattern): void {
    this.state.strokePattern = pattern;
    this.notify();
  }

  setScribbleToErase(enabled: boolean): void {
    this.state.scribbleToErase = enabled;
    this.notify();
  }

  setCircleToSelect(enabled: boolean): void {
    this.state.circleToSelect = enabled;
    this.notify();
  }

  setStraightLineRecognition(enabled: boolean): void {
    this.state.straightLineRecognition = enabled;
    this.notify();
  }

  setSnapRecognizedLines(enabled: boolean): void {
    this.state.snapRecognizedLines = enabled;
    this.notify();
  }

  setRoughShapeRecognition(enabled: boolean): void {
    this.state.roughShapeRecognition = enabled;
    this.notify();
  }

  setSnapRecognizedShapes(enabled: boolean): void {
    this.state.snapRecognizedShapes = enabled;
    this.notify();
  }

  setRulerEnabled(enabled: boolean): void {
    this.state.rulerEnabled = enabled;
    this.notify();
  }

  setSelectionShape(shape: SelectionShape): void {
    this.state.selectionShape = shape === 'rectangle' ? 'rectangle' : 'freeform';
    this.notify();
  }

  setStabilization(level: number): void {
    this.state.stabilization = Math.max(0, Math.min(100, level));
    this.notify();
  }

  /** Reset to defaults. */
  reset(): void {
    this.state = { ...DEFAULT_TOOL_STATE };
    this.notify();
  }
}
