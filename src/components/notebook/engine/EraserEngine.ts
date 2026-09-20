import type { Stroke, Shape, EraserMode } from './drawingTypes.ts';
import type { DrawingEngine } from './DrawingEngine.ts';
import type { HistoryManager } from './HistoryManager.ts';
import type { ShapeManager } from './ShapeManager.ts';
import type { RulerManager } from './RulerManager.ts';
import { cutStroke, eraserCapsule, exposedEraser, regionIntersects, strokeRegion, translateRegion, type InkPoint } from './inkRegion.ts';
import { splitOutsideCapsule, strokeHitsCapsule, eraseBounds, boundsOverlap, type EraseBounds } from './capsuleErase.ts';
import { gate0Profiler } from '../../../dev/gate0Profiler.ts';
import clipping from 'polygon-clipping';
import { cloneStrokeSnapshot } from './cloneStrokeSnapshot.ts';

export class EraserEngine {
  private shapeManager?: ShapeManager;
  private rulerManager?: RulerManager;
  private changes = new Map<string, { before: Stroke | null; after: Stroke | null }>();
  private erasedShapes: Shape[] = [];
  private strokeOrder: string[] = [];
  private historyChangeCallback: (() => void) | null = null;
  private bounds = new WeakMap<Stroke, EraseBounds>();
  private dirty: EraseBounds | null = null;
  private fullPresentation = false;
  private rulerSeparated = new Set<string>();
  private rulerProtected = new Set<string>();
  private usedIds = new Set<string>();

  private getBounds = (stroke: Stroke): EraseBounds => {
    let bounds = this.bounds.get(stroke);
    if (!bounds) { bounds = eraseBounds(stroke); this.bounds.set(stroke, bounds); }
    return bounds;
  };

  present(): void {
    if (this.fullPresentation || !this.dirty) this.drawingEngine.redraw();
    else this.drawingEngine.redraw(this.dirty, this.getBounds);
    this.dirty = null;
    this.fullPresentation = false;
  }

  private drawingEngine: DrawingEngine;
  private historyManager: HistoryManager;
  constructor(drawingEngine: DrawingEngine, historyManager: HistoryManager) {
    this.drawingEngine = drawingEngine;
    this.historyManager = historyManager;
  }

  setShapeManager(manager: ShapeManager): void { this.shapeManager = manager; }
  setRulerManager(manager: RulerManager): void { this.rulerManager = manager; }
  setHistoryChangeCallback(callback: () => void): void { this.historyChangeCallback = callback; }

  startErasing(mode: EraserMode, redraw = true): boolean {
    this.changes.clear();
    this.bounds = new WeakMap();
    this.dirty = null;
    this.fullPresentation = mode === 'all';
    this.rulerSeparated.clear();
    this.rulerProtected.clear();
    this.erasedShapes = [];
    this.strokeOrder = this.drawingEngine.getStrokes().map(stroke => stroke.id);
    this.usedIds = new Set(this.strokeOrder);
    if (mode === 'all') {
      const body = this.rulerManager?.getBodyPolygon() ?? [];
      for (const stroke of [...this.drawingEngine.getStrokes()]) {
        if (this.drawingEngine.getLayerManager?.() && !this.drawingEngine.getLayerManager().isEditable(stroke.layerId)) continue;
        this.applyCut(stroke, body.length ? cutStroke(stroke, exposedEraser(strokeRegion(stroke), body)) : null);
      }
      if (!body.length && this.shapeManager) {
        const layers = this.drawingEngine.getLayerManager?.();
        const editable = this.shapeManager.getShapes().filter(shape => !layers || layers.isEditable(shape.layerId));
        this.erasedShapes = this.shapeManager.removeShapes(new Set(editable.map(shape => shape.id)));
      }
      if (redraw) this.drawingEngine.redraw();
    }
    return this.changes.size > 0 || this.erasedShapes.length > 0;
  }

  private applyCut(stroke: Stroke, next: Stroke | null | undefined): boolean {
    if (next === undefined) return false;
    const bounds = this.getBounds(stroke);
    this.dirty = this.dirty ? { left: Math.min(this.dirty.left,bounds.left), top: Math.min(this.dirty.top,bounds.top),
      right: Math.max(this.dirty.right,bounds.right), bottom: Math.max(this.dirty.bottom,bounds.bottom) } : { ...bounds };
    const previous = this.changes.get(stroke.id);
    this.changes.set(stroke.id, { before: previous ? previous.before : cloneStrokeSnapshot(stroke), after: next });
    const strokes = this.drawingEngine.getStrokes();
    const index = strokes.findIndex(candidate => candidate.id === stroke.id);
    // Keep object order: translucent overlaps must not change after an erase.
    if (index >= 0) strokes.splice(index, 1, ...(next ? [next] : []));
    return true;
  }

  private applyFragments(stroke: Stroke, fragments: Stroke['points'][]): boolean {
    return this.applyReplacements(stroke, fragments.map(points => ({ ...stroke, points,
      ...(stroke.inkClip ? { inkClip: translateRegion(stroke.inkClip, stroke.points[0].x-points[0].x, stroke.points[0].y-points[0].y) } : {}) })));
  }

  private applyReplacements(stroke: Stroke, fragments: Stroke[]): boolean {
    const strokes = this.drawingEngine.getStrokes();
    const index = strokes.indexOf(stroke);
    const replacements = fragments.map((fragment, part): Stroke => {
      let id = stroke.id;
      if (part) {
        let suffix = part;
        do { id = `${stroke.id}:erase:${suffix++}`; } while (this.usedIds.has(id));
        this.usedIds.add(id);
      }
      if (this.rulerSeparated.has(stroke.id)) this.rulerSeparated.add(id);
      return { ...fragment, id };
    });
    this.applyCut(stroke, replacements[0] ?? null);
    replacements.slice(1).forEach(next => this.changes.set(next.id, { before: null, after: next }));
    if (replacements.length > 1) strokes.splice(index + 1, 0, ...replacements.slice(1));
    return true;
  }

  eraseAt(x: number, y: number, mode: EraserMode, radius = 12, redraw = true): boolean {
    return this.eraseSweep({ x, y }, { x, y }, mode, radius, redraw);
  }

  /** One analytic sweep, without distance-dependent stroke scan subdivision. */
  eraseSweep(start: InkPoint, end: InkPoint, mode: EraserMode, radius = 12, redraw = true): boolean {
    const operationStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    const active = gate0Profiler.getActive('eraser-gesture');
    if (mode === 'all') return false;
    const body = this.rulerManager?.getBodyPolygon() ?? [];
    // Exact ruler clipping is a compatibility path, not the ordinary ink path.
    let exposed: ReturnType<typeof exposedEraser> | undefined;
    const rulerPoints = body[0]?.[0] ?? [];
    const rulerBounds = {left:Math.min(...rulerPoints.map(p=>p[0])),right:Math.max(...rulerPoints.map(p=>p[0])),
      top:Math.min(...rulerPoints.map(p=>p[1])),bottom:Math.max(...rulerPoints.map(p=>p[1]))};
    let changed = false;
    const layers = this.drawingEngine.getLayerManager?.();
    const sweepBounds = { left: Math.min(start.x,end.x)-radius, right: Math.max(start.x,end.x)+radius,
      top: Math.min(start.y,end.y)-radius, bottom: Math.max(start.y,end.y)+radius };
    for (const stroke of [...this.drawingEngine.getStrokes()]) {
      if (layers && !layers.isEditable(stroke.layerId)) continue;
      if (mode === 'highlighter' && stroke.tool !== 'highlighter') continue;
      if (this.rulerProtected.has(stroke.id)) continue;
      gate0Profiler.increment(active, 'strokesScanned');
      if (!boundsOverlap(this.getBounds(stroke), sweepBounds)) continue;
      gate0Profiler.increment(active, 'segmentsScanned', Math.max(1, stroke.points.length-1));
      if (!strokeHitsCapsule(stroke, start, end, radius)) continue;
      if (body.length && !this.rulerSeparated.has(stroke.id) && boundsOverlap(this.getBounds(stroke),rulerBounds)) {
        exposed ??= exposedEraser(eraserCapsule(start,end,Math.max(.01,radius)),body);
        if (!exposed.length) continue;
        if (!regionIntersects(strokeRegion(stroke), exposed)) continue;
        const region = strokeRegion(stroke), origin = stroke.points[0];
        const protectedRegion = clipping.intersection(region, body);
        const outsideRegion = clipping.difference(region, body);
        this.rulerSeparated.add(stroke.id);
        if (protectedRegion.length) {
          gate0Profiler.increment(active, 'rulerSeparations');
          const protectedStroke = { ...stroke, inkClip: translateRegion(protectedRegion,-origin.x,-origin.y) };
          const outsideStroke = { ...stroke, inkClip: translateRegion(outsideRegion,-origin.x,-origin.y) };
          const fragments = mode === 'pixel' && outsideRegion.length ? splitOutsideCapsule(outsideStroke,start,end,radius) : [];
          const surviving = fragments === null ? [outsideStroke] : fragments.map(points => ({...outsideStroke,points,
            inkClip: translateRegion(outsideStroke.inkClip,origin.x-points[0].x,origin.y-points[0].y)}));
          const index = this.drawingEngine.getStrokes().indexOf(stroke);
          this.applyReplacements(stroke,[protectedStroke,...surviving]);
          this.rulerProtected.add(this.drawingEngine.getStrokes()[index].id);
          changed = true;
          continue;
        }
      }
      if (mode !== 'pixel') {
        // Existing clips can hide a hit on the original centerline.
        if (stroke.inkClip && !regionIntersects(strokeRegion(stroke), eraserCapsule(start,end,radius))) continue;
        changed = this.applyCut(stroke, null) || changed;
      } else {
        const fragments = splitOutsideCapsule(stroke, start, end, radius);
        if (fragments) changed = this.applyFragments(stroke, fragments) || changed;
      }
    }
    // Shape erasing retains its existing object-level hit testing.
    const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / Math.max(2, radius / 2)));
    const shapeHits = new Set<string>();
    for (let i = 0; this.shapeManager?.getShapes().length && mode !== 'highlighter' && i <= steps; i++) {
      const x = start.x + (end.x - start.x) * i / steps;
      const y = start.y + (end.y - start.y) * i / steps;
      this.shapeManager?.findShapesNearPoint(x, y, radius).forEach(id => shapeHits.add(id));
    }
    for (const id of shapeHits) {
      const shape = this.shapeManager?.getShapes().find(candidate => candidate.id === id);
      if (!shape) continue;
      // Shapes have object-level erasure. Do not delete an intersecting shape
      // through the ruler; partial shape geometry is outside the stroke model.
      const diagonal = Math.hypot(shape.width, shape.height) / 2 + shape.strokeWidth;
      const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
      if (body.length && regionIntersects(eraserCapsule(center, center, Math.max(1, diagonal)), body)) continue;
      const removed = this.shapeManager?.removeShape(id);
      if (removed) {
        this.erasedShapes.push(removed);
        const damage = {left:center.x-diagonal-2,top:center.y-diagonal-2,right:center.x+diagonal+2,bottom:center.y+diagonal+2};
        this.dirty = this.dirty ? {left:Math.min(this.dirty.left,damage.left),top:Math.min(this.dirty.top,damage.top),
          right:Math.max(this.dirty.right,damage.right),bottom:Math.max(this.dirty.bottom,damage.bottom)} : damage;
        changed = true;
      }
    }
    if (changed && redraw) this.drawingEngine.redraw();
    if (operationStartedAt) gate0Profiler.sample(active, 'eraseSweepDurationMs', performance.now() - operationStartedAt);
    return changed;
  }

  finishErasing(): boolean {
    if (!this.changes.size && !this.erasedShapes.length) return false;
    const changes = [...this.changes].map(([id, change]) => [id, {
      before: change.before, after: change.after ? cloneStrokeSnapshot(change.after) : null,
    }] as const);
    const shapes = structuredClone(this.erasedShapes);
    const order = new Map(this.strokeOrder.map((id, index) => [id, index]));
    const finalOrder = new Map(this.drawingEngine.getStrokes().map((stroke, index) => [stroke.id, index]));
    const apply = (redo: boolean) => {
      const strokes = this.drawingEngine.getStrokes();
      for (const [id, change] of changes) {
        const index = strokes.findIndex(stroke => stroke.id === id);
        if (index >= 0) strokes.splice(index, 1);
        const value = redo ? change.after : change.before;
        if (value) strokes.push(cloneStrokeSnapshot(value));
      }
      const positions = redo ? finalOrder : order;
      strokes.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
      if (redo) this.shapeManager?.removeShapes(new Set(shapes.map(shape => shape.id)));
      else shapes.forEach(shape => this.shapeManager?.addShape(structuredClone(shape)));
      this.drawingEngine.redraw();
      this.historyChangeCallback?.();
    };
    this.historyManager.pushExecuted({ description: 'Erase', execute: () => apply(true), undo: () => apply(false) });
    this.changes.clear();
    this.erasedShapes = [];
    return true;
  }

  /** Remove a known set of strokes as one undoable gesture command. */
  eraseStrokeIds(ids: Set<string>, description = 'Scribble erase'): boolean {
    if (ids.size === 0) return false;
    const erasedStrokes = this.drawingEngine.removeStrokes(ids);
    if (erasedStrokes.length === 0) return false;
    const erasedIds = new Set(erasedStrokes.map(stroke => stroke.id));
    this.drawingEngine.redraw();
    this.historyManager.pushExecuted({
      description,
      execute: () => { this.drawingEngine.removeStrokes(erasedIds); this.drawingEngine.redraw(); this.historyChangeCallback?.(); },
      undo: () => { erasedStrokes.forEach(stroke => this.drawingEngine.addStroke(stroke)); this.drawingEngine.redraw(); this.historyChangeCallback?.(); },
    });
    return true;
  }
}
