import type { LineStyle } from './lineStyleGeometry.ts';
import { recropImageGeometry } from './imageAppearance.ts';
// ============================================
// Panvas — Selection Engine
// ============================================
// Handles selecting, moving, resizing, and deleting strokes/shapes.

import type { SelectedElement, BoundingBox, ImageObject, Shape, Stroke, StrokePoint, TextObject } from './drawingTypes.ts';
import type { DrawingEngine } from './DrawingEngine.ts';
import type { ShapeManager } from './ShapeManager.ts';
import type { HistoryManager } from './HistoryManager.ts';
import type { ViewportManager } from './ViewportManager.ts';
import type { TextManager } from './TextManager.ts';
import type { ImageManager } from './ImageManager.ts';
import { LayerManager } from './LayerManager.ts';
import { generateId } from '../../../lib/utils/id.ts';
import { isPointInsideLoop } from './circleSelectGesture.ts';
import { applyGroupedTranslation, reorderQueueWithinLayers, type MixedPlacementObject, type ZOrderAction } from './mixedPlacement.ts';
// Keep this engine import relative: the focused Node interaction suite runs
// without Vite's `@` alias resolver.
import { createHandwritingConversionCommand } from '../../../services/recognition/conversion.ts';
import { getEligibleSelectedHandwritingStrokes } from '../../../services/recognition/bulkConversion.ts';
import { validateElementSnapshot } from '../../../services/elements/LocalElementRepository.ts';

type ResizeHandle = 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br' | 'rotate' | null;
type ObjectOrderSnapshot = {
  strokes: Stroke[];
  shapes: Shape[];
  texts: TextObject[];
  images: ImageObject[];
};

export class SelectionEngine {
  private voiceDeleteHandler?: (noteId: string) => void;
  setVoiceDeleteHandler(handler?: (noteId: string) => void): void { this.voiceDeleteHandler = handler; }
  private drawingEngine: DrawingEngine;
  private shapeManager: ShapeManager;
  private historyManager: HistoryManager;
  private viewport: ViewportManager;
  private textManager: TextManager;
  private imageManager: ImageManager;
  private layerManager: LayerManager;

  private selectedIds: Set<string> = new Set();
  private selectedElements: SelectedElement[] = [];
  private selectionListeners: Set<() => void> = new Set();

  // Drag state
  private isDragging = false;
  private dragMode: 'move' | Exclude<ResizeHandle, null> = 'move';
  private dragStartX = 0;
  private dragStartY = 0;

  // Undo state
  private originalPositions: Map<string, any> = new Map();
  private originalInkClips: Map<string, Stroke['inkClip']> = new Map();
  private originalBox: BoundingBox | null = null;
  private rotationStartAngle = 0;

  constructor(drawingEngine: DrawingEngine, shapeManager: ShapeManager, historyManager: HistoryManager, viewport: ViewportManager, textManager: TextManager, imageManager: ImageManager, layerManager: LayerManager = new LayerManager()) {
    this.drawingEngine = drawingEngine;
    this.shapeManager = shapeManager;
    this.historyManager = historyManager;
    this.viewport = viewport;
    this.textManager = textManager;
    this.imageManager = imageManager;
    this.layerManager = layerManager;
  }

  getSelectedElements(): SelectedElement[] {
    return this.selectedElements;
  }

  subscribe(listener: () => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  private notifySelectionChange(): void {
    this.selectionListeners.forEach(listener => listener());
  }

  hasSelectedStrokes(): boolean {
    return this.getSelectedStrokes().length > 0;
  }

  /** Returns a copied, ordered snapshot suitable for asynchronous recognition. */
  getSelectedStrokes(): Stroke[] {
    const selectedIds = new Set(this.selectedElements.filter(element => element.type === 'stroke').map(element => element.id));
    return getEligibleSelectedHandwritingStrokes(
      this.drawingEngine.getStrokes(),
      selectedIds,
      stroke => this.layerManager.isEditable(stroke.layerId),
    );
  }

  getSelectedStrokeBoundingBox(): BoundingBox | null {
    const strokes = this.getSelectedStrokes();
    if (strokes.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of strokes) {
      for (const point of stroke.points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
    return Number.isFinite(minX)
      ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
      : null;
  }

  clearSelection(): void {
    this.selectedIds.clear();
    this.selectedElements = [];
    this.textManager.setActiveTextId?.(undefined);
    this.notifySelectionChange();
    this.drawingEngine.redraw();
  }

  selectElement(id: string, type: 'stroke' | 'shape' | 'text' | 'image', multi = false): void {
    const source = type === 'stroke' ? this.drawingEngine.getStrokes() : type === 'shape' ? this.shapeManager.getShapes() : type === 'text' ? this.textManager.getTexts() : this.imageManager.getImages();
    const object = source.find(item => item.id === id);
    if (!object || !this.layerManager.isEditable(object.layerId)) return;
    if (!multi) {
      this.clearSelection();
    }
    if (!this.selectedIds.has(id)) {
      this.selectedIds.add(id);
      this.selectedElements.push({ type, id });
      this.notifySelectionChange();
      this.drawingEngine.redraw();
    }
  }

  select(id: string, type: 'stroke' | 'shape' | 'text' | 'image', multi = false): void {
    this.selectElement(id, type, multi);
  }

  /**
   * Replaces only the currently selected strokes in one history entry. The
   * untouched full stroke order is snapshotted so undo restores every original
   * point, pressure, timestamp, identifier, and layer exactly.
   */
  replaceSelectedStrokesWithText(text: TextObject): boolean {
    const strokes = this.getSelectedStrokes();
    if (strokes.length === 0) return false;
    return this.replaceSelectedStrokesWithTexts(strokes, [text]);
  }

  /** Replaces an exact selected stroke snapshot with one or more text lines. */
  replaceSelectedStrokesWithTexts(strokes: readonly Stroke[], texts: readonly TextObject[]): boolean {
    if (strokes.length === 0 || texts.length === 0) return false;
    const currentById = new Map(this.drawingEngine.getStrokes().map(stroke => [stroke.id, stroke]));
    const sourceStrokes = strokes.map(stroke => structuredClone(stroke));
    const sourceIsStillValid = sourceStrokes.every(source => {
      const current = currentById.get(source.id);
      return current !== undefined
        && this.layerManager.isEditable(current.layerId)
        && JSON.stringify(current) === JSON.stringify(source);
    });
    if (!sourceIsStillValid) return false;

    const convertedIds = new Set(sourceStrokes.map(stroke => stroke.id));
    // Dialog focus can clear the live visual selection after the immutable
    // stroke snapshot has been taken. That does not invalidate unchanged ink.
    // Reconstruct the source selection so undo restores useful selection state.
    const sourceSelection = this.selectedElements.length > 0
      ? this.selectedElements.map(element => ({ ...element }))
      : sourceStrokes.map(stroke => ({ type: 'stroke' as const, id: stroke.id }));
    const retainedSelection = sourceSelection.filter(element => (
      element.type !== 'stroke' || !convertedIds.has(element.id)
    ));
    const replacementSelection: SelectedElement[] = [
      ...retainedSelection,
      ...texts.map(text => ({ type: 'text' as const, id: text.id })),
    ];
    this.historyManager.push(createHandwritingConversionCommand({
      getStrokes: () => this.drawingEngine.getStrokes(),
      setStrokes: next => this.drawingEngine.setStrokes(next),
      addText: next => this.textManager.addText(next),
      removeText: id => { this.textManager.removeText(id); },
      setSelection: elements => {
        this.selectedElements = elements.map(element => ({ ...element }));
        this.selectedIds = new Set(elements.map(element => element.id));
        this.notifySelectionChange();
      },
      redraw: () => this.drawingEngine.redraw(),
    }, sourceStrokes, texts, { sourceSelection, replacementSelection }));
    return true;
  }

  deleteSelection(): void {
    if (this.selectedElements.length === 0) return;
    const selected = [...this.selectedElements];
    const voiceIds = new Set<string>();
    if (this.voiceDeleteHandler) for (const element of selected) {
      const object = this.textManager.getTexts().find(item => item.id === element.id);
      if (object?.metadata?.isVoiceNote) { voiceIds.add(element.id); this.voiceDeleteHandler(String(object.metadata.audioNoteId)); }
    }
    const elements = selected.filter(element => !voiceIds.has(element.id));
    if (!elements.length) return;

    // Store exact references for undo
    const strokesToRestore: any[] = [];
    const shapesToRestore: any[] = [];
    const imagesToRestore: any[] = [];
    const textsToRestore: TextObject[] = [];

    this.historyManager.push({
      description: 'Delete selection',
      execute: () => {
        const strokeIds = new Set<string>();
        const shapeIds = new Set<string>();
        const textIds = new Set<string>();
        const imageIds = new Set<string>();
        for (const el of elements) {
          if (el.type === 'stroke') strokeIds.add(el.id);
          else if (el.type === 'shape') shapeIds.add(el.id);
          else if (el.type === 'text') textIds.add(el.id);
          else if (el.type === 'image') imageIds.add(el.id);
        }
        const removedStrokes = this.drawingEngine.removeStrokes(strokeIds);
        strokesToRestore.length = 0;
        strokesToRestore.push(...removedStrokes);

        const removedShapes = this.shapeManager.removeShapes(shapeIds);
        shapesToRestore.length = 0;
        shapesToRestore.push(...removedShapes);

        const removedTexts = this.textManager.removeTexts(textIds);
        textsToRestore.length = 0;
        textsToRestore.push(...removedTexts);

        const removedImages = this.imageManager.removeImages(imageIds);
        imagesToRestore.length = 0;
        imagesToRestore.push(...removedImages);

        this.clearSelection();
      },
      undo: () => {
        for (const s of strokesToRestore) this.drawingEngine.addStroke(s);
        for (const s of shapesToRestore) this.shapeManager.addShape(s);
        for (const img of imagesToRestore) this.imageManager.addImage(img);
        for (const text of textsToRestore) this.textManager.addText(text);
        this.selectedElements = [...elements];
        this.selectedIds = new Set(elements.map(e => e.id));
        this.notifySelectionChange();
        this.drawingEngine.redraw();
      }
    });
  }

  changeColor(color: string, toolFilter?: string): boolean {
    if (this.selectedElements.length === 0) return false;

    const elements = [...this.selectedElements];
    const origMap = new Map<string, string>();
    const finalMap = new Map<string, string>();

    for (const el of elements) {
      if (el.type === 'stroke') {
        const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
        if (stroke && (!toolFilter || stroke.tool === toolFilter)) {
          origMap.set(el.id, stroke.color);
          finalMap.set(el.id, color);
          stroke.color = color;
        }
      } else if (el.type === 'shape' && !toolFilter) {
        const shape = this.shapeManager.getShapes().find(item => item.id === el.id);
        if (shape) {
          origMap.set(el.id, shape.color);
          finalMap.set(el.id, color);
          shape.color = color;
        }
      }
    }

    if (origMap.size === 0) return false;

    this.historyManager.push({
      description: 'Change color',
      execute: () => {
        for (const el of elements) {
          const finalColor = finalMap.get(el.id);
          if (!finalColor) continue;
          if (el.type === 'stroke') {
            const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
            if (stroke) stroke.color = finalColor;
          } else if (el.type === 'shape') {
            const shape = this.shapeManager.getShapes().find(item => item.id === el.id);
            if (shape) shape.color = finalColor;
          }
        }
        this.drawingEngine.redraw();
      },
      undo: () => {
        for (const el of elements) {
          const origColor = origMap.get(el.id);
          if (!origColor) continue;
          if (el.type === 'stroke') {
            const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
            if (stroke) stroke.color = origColor;
          } else if (el.type === 'shape') {
            const shape = this.shapeManager.getShapes().find(item => item.id === el.id);
            if (shape) shape.color = origColor;
          }
        }
        this.drawingEngine.redraw();
      }
    });

    this.drawingEngine.redraw();
    return true;
  }

  changeThickness(thickness: number, toolFilter?: string): boolean {
    if (this.selectedElements.length === 0) return false;

    const elements = [...this.selectedElements];
    const origMap = new Map<string, number>();
    const finalMap = new Map<string, number>();

    for (const el of elements) {
      if (el.type === 'stroke') {
        const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
        if (stroke && (!toolFilter || stroke.tool === toolFilter)) {
          origMap.set(el.id, stroke.thickness);
          finalMap.set(el.id, thickness);
          stroke.thickness = thickness;
        }
      } else if (el.type === 'shape' && !toolFilter) {
        const shape = this.shapeManager.getShapes().find(item => item.id === el.id);
        if (shape) {
          origMap.set(el.id, shape.strokeWidth);
          finalMap.set(el.id, thickness);
          shape.strokeWidth = thickness;
        }
      }
    }

    if (origMap.size === 0) return false;

    this.historyManager.pushExecuted({
      description: 'Change thickness',
      execute: () => {
        for (const el of elements) {
          const finalThickness = finalMap.get(el.id);
          if (finalThickness === undefined) continue;
          if (el.type === 'stroke') {
            const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
            if (stroke) stroke.thickness = finalThickness;
          } else if (el.type === 'shape') {
            const shape = this.shapeManager.getShapes().find(item => item.id === el.id);
            if (shape) shape.strokeWidth = finalThickness;
          }
        }
        this.drawingEngine.redraw();
      },
      undo: () => {
        for (const el of elements) {
          const origThickness = origMap.get(el.id);
          if (origThickness === undefined) continue;
          if (el.type === 'stroke') {
            const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
            if (stroke) stroke.thickness = origThickness;
          } else if (el.type === 'shape') {
            const shape = this.shapeManager.getShapes().find(item => item.id === el.id);
            if (shape) shape.strokeWidth = origThickness;
          }
        }
        this.drawingEngine.redraw();
      }
    });

    this.drawingEngine.redraw();
    return true;
  }

  changeOpacity(opacity: number, toolFilter?: string): boolean {
    if (this.selectedElements.length === 0) return false;

    const elements = [...this.selectedElements];
    const origMap = new Map<string, number>();
    const finalMap = new Map<string, number>();

    for (const el of elements) {
      if (el.type === 'stroke') {
        const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
        if (stroke && (!toolFilter || stroke.tool === toolFilter)) {
          origMap.set(el.id, stroke.opacity);
          finalMap.set(el.id, opacity);
          stroke.opacity = opacity;
        }
      } else if (el.type === 'shape' && !toolFilter) {
        const shape = this.shapeManager.getShapes().find(item => item.id === el.id);
        if (shape) {
          origMap.set(el.id, shape.opacity ?? 1);
          finalMap.set(el.id, opacity);
          shape.opacity = opacity;
        }
      } else if (el.type === 'image' && !toolFilter) {
        const image = this.imageManager.getImages().find(item => item.id === el.id);
        if (image) {
          origMap.set(el.id, image.opacity ?? 1);
          finalMap.set(el.id, opacity);
          image.opacity = opacity;
        }
      }
    }

    if (origMap.size === 0) return false;

    this.historyManager.pushExecuted({
      description: 'Change opacity',
      execute: () => {
        for (const el of elements) {
          const finalOpacity = finalMap.get(el.id);
          if (finalOpacity === undefined) continue;
          if (el.type === 'stroke') {
            const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
            if (stroke) stroke.opacity = finalOpacity;
          } else if (el.type === 'shape') {
            const shape = this.shapeManager.getShapes().find(item => item.id === el.id);
            if (shape) shape.opacity = finalOpacity;
          } else if (el.type === 'image') {
            const image = this.imageManager.getImages().find(item => item.id === el.id);
            if (image) image.opacity = finalOpacity;
          }
        }
        this.drawingEngine.redraw();
      },
      undo: () => {
        for (const el of elements) {
          const origOpacity = origMap.get(el.id);
          if (origOpacity === undefined) continue;
          if (el.type === 'stroke') {
            const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
            if (stroke) stroke.opacity = origOpacity;
          } else if (el.type === 'shape') {
            const shape = this.shapeManager.getShapes().find(item => item.id === el.id);
            if (shape) shape.opacity = origOpacity;
          } else if (el.type === 'image') {
            const image = this.imageManager.getImages().find(item => item.id === el.id);
            if (image) image.opacity = origOpacity;
          }
        }
        this.drawingEngine.redraw();
      }
    });

    this.drawingEngine.redraw();
    return true;
  }

  changeShapeFill(fill: string | null): boolean {
    const shapes = this.selectedElements
      .filter(element => element.type === 'shape')
      .map(element => this.shapeManager.getShapes().find(shape => shape.id === element.id))
      .filter((shape): shape is NonNullable<typeof shape> => Boolean(shape));
    if (shapes.length === 0) return false;
    const before = shapes.map(shape => ({ id: shape.id, fill: shape.fill }));
    const apply = (value: string | null) => {
      shapes.forEach(shape => { shape.fill = value; });
      this.drawingEngine.redraw();
    };
    apply(fill);
    this.historyManager.pushExecuted({
      description: 'Change shape fill',
      execute: () => apply(fill),
      undo: () => {
        before.forEach(entry => {
          const shape = this.shapeManager.getShapes().find(item => item.id === entry.id);
          if (shape) shape.fill = entry.fill;
        });
        this.drawingEngine.redraw();
      },
    });
    return true;
  }

  changeLineStyle(style: LineStyle): void {
    const objects = this.selectedElements.filter(el => el.type === 'shape').map(el => this.shapeManager.getShapes().find(shape => shape.id === el.id)).filter((shape): shape is Shape => !!shape && this.layerManager.isEditable(shape.layerId) && (shape.shapeType === 'line' || shape.shapeType === 'arrow'));
    if (!objects.length) return;
    const before = objects.map(shape => shape.lineStyle);
    const apply = (undo = false) => { objects.forEach((entry, i) => { const shape = this.shapeManager.getShapes().find(item => item.id === entry.id); if (shape) { shape.lineStyle = undo ? before[i] : style; if (!shape.lineStyle) delete shape.lineStyle; } }); this.drawingEngine.redraw(); };
    this.historyManager.push({ description: 'Change line style', execute: () => apply(), undo: () => apply(true) });
  }

  cropImage(id: string, crop: BoundingBox): boolean {
    const image = this.imageManager.getImages().find(item => item.id === id);
    if (!image || !this.layerManager.isEditable(image.layerId) ||
      ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
      crop.x + crop.width > 1 + 1e-8 || crop.y + crop.height > 1 + 1e-8) return false;
    const before = { crop: image.crop, x: image.x, y: image.y, width: image.width, height: image.height };
    const after = { crop: { ...crop }, ...recropImageGeometry(image, crop) };
    const apply = (value: typeof before) => {
      const current = this.imageManager.getImages().find(item => item.id === id);
      if (!current) return;
      Object.assign(current, value);
      if (!value.crop) delete current.crop;
      this.notifySelectionChange();
      this.drawingEngine.redraw();
    };
    apply(after);
    this.historyManager.pushExecuted({ description: 'Crop image', execute: () => apply(after), undo: () => apply(before) });
    return true;
  }

  rotateSelection(deltaDegrees: number): boolean {
    const objects = this.selectedElements
      .filter(element => element.type === 'shape' || element.type === 'image' || element.type === 'text')
      .map(element => element.type === 'shape'
        ? this.shapeManager.getShapes().find(shape => shape.id === element.id)
        : element.type === 'image'
          ? this.imageManager.getImages().find(image => image.id === element.id)
          : this.textManager.getTexts().find(text => text.id === element.id))
      .filter((object): object is NonNullable<typeof object> => Boolean(object));
    if (objects.length === 0) return false;
    const before = objects.map(object => ({ id: object.id, rotation: object.rotation ?? 0 }));
    const apply = (delta: number) => {
      objects.forEach(object => { object.rotation = ((object.rotation ?? 0) + delta + 360) % 360; });
      this.drawingEngine.redraw();
    };
    apply(deltaDegrees);
    this.historyManager.pushExecuted({
      description: 'Rotate selection',
      execute: () => apply(deltaDegrees),
      undo: () => {
        before.forEach(entry => {
          const shape = this.shapeManager.getShapes().find(item => item.id === entry.id);
          const image = this.imageManager.getImages().find(item => item.id === entry.id);
          const text = this.textManager.getTexts().find(item => item.id === entry.id);
          if (shape) shape.rotation = entry.rotation;
          if (image) image.rotation = entry.rotation;
          if (text) text.rotation = entry.rotation;
        });
        this.drawingEngine.redraw();
      },
    });
    return true;
  }

  getHandleAt(x: number, y: number): { id: string, handle: Exclude<ResizeHandle, null> } | null {
    if (this.usesStickyDomControls()) return null;
    const handleSize = 12 / this.viewport.getState().scale;
    const h2 = handleSize / 2;

    // Check backwards (top-most elements first)
    for (let i = this.selectedElements.length - 1; i >= 0; i--) {
      const el = this.selectedElements[i];
      const box = this.getBoundingBox(el);
      if (!box) continue;

      const midX = box.x + box.width / 2;
      const midY = box.y + box.height / 2;

      const rotation = this.getObjectRotation(el) * Math.PI / 180;
      const transform = (px: number, py: number) => {
        const dx = px - midX, dy = py - midY;
        return { cx: midX + dx * Math.cos(rotation) - dy * Math.sin(rotation), cy: midY + dx * Math.sin(rotation) + dy * Math.cos(rotation) };
      };
      const rawHandles: { handle: Exclude<ResizeHandle, null>; cx: number; cy: number }[] = [
        { handle: 'tl', cx: box.x - 4, cy: box.y - 4 },
        { handle: 'tc', cx: midX, cy: box.y - 4 },
        { handle: 'tr', cx: box.x + box.width + 4, cy: box.y - 4 },
        { handle: 'ml', cx: box.x - 4, cy: midY },
        { handle: 'mr', cx: box.x + box.width + 4, cy: midY },
        { handle: 'bl', cx: box.x - 4, cy: box.y + box.height + 4 },
        { handle: 'bc', cx: midX, cy: box.y + box.height + 4 },
        { handle: 'br', cx: box.x + box.width + 4, cy: box.y + box.height + 4 },
        { handle: 'rotate', ...transform(midX, box.y - 32 / this.viewport.getState().scale) },
      ];
      const handles: { handle: Exclude<ResizeHandle, null>; cx: number; cy: number }[] = rawHandles.map(item => item.handle === 'rotate' ? item : ({ handle: item.handle, ...transform(item.cx, item.cy) }));

      for (const h of handles) {
        if (x >= h.cx - h2 && x <= h.cx + h2 && y >= h.cy - h2 && y <= h.cy + h2) {
          return { id: el.id, handle: h.handle };
        }
      }
    }
    return null;
  }

  /** Select element at given coordinates (pointer down). */
  selectAt(x: number, y: number, shiftKey: boolean = false): boolean {
    const handleHit = this.getHandleAt(x, y);
    if (handleHit) {
      // User clicked a resize handle of an already selected element
      return true;
    }

    const topHit = this.hitTest(x, y);
    // Preserve group dragging only when a higher layer is not covering it.
    for (const el of this.selectedElements) {
      const box = this.getBoundingBox(el);
      if ((!topHit || this.selectedIds.has(topHit.id)) && !shiftKey && box && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
        return true;
      }
    }

    const hitId = topHit?.id;
    const hitType = topHit?.type;

    if (hitId && hitType) {
      if (!shiftKey) {
        this.clearSelection();
      }

      if (this.selectedIds.has(hitId)) {
        if (shiftKey) {
          this.selectedIds.delete(hitId);
          this.selectedElements = this.selectedElements.filter(e => e.id !== hitId);
        }
      } else {
        this.selectedIds.add(hitId);
        this.selectedElements.push({ type: hitType, id: hitId });
      }
      this.notifySelectionChange();
      this.drawingEngine.redraw();
      return true;
    }

    if (!shiftKey) {
      this.clearSelection();
    }
    return false;
  }

  /** Same stack as rendering: layer first, then text / shape / stroke / image. */
  hitTest(x: number, y: number): SelectedElement | null {
    const shapeHits = new Set(this.shapeManager.findShapesNearPoint(x, y, 5));
    const strokeHits = new Set(this.drawingEngine.findStrokesNearPoint(x, y, 5));
    const contains = (item: { x: number; y: number; width: number; height?: number; rotation?: number }) => {
      const h = item.height || 100, cx = item.x + item.width / 2, cy = item.y + h / 2;
      const angle = -(item.rotation ?? 0) * Math.PI / 180, dx = x - cx, dy = y - cy;
      const localX = cx + dx * Math.cos(angle) - dy * Math.sin(angle);
      const localY = cy + dx * Math.sin(angle) + dy * Math.cos(angle);
      return localX >= item.x && localX <= item.x + item.width && localY >= item.y && localY <= item.y + h;
    };
    for (const layer of [...this.layerManager.getLayers()].reverse()) {
      if (!layer.visible || layer.locked) continue;
      const onLayer = (item: { layerId?: string }) => (item.layerId ?? 'layer-default') === layer.id;
      const text = [...this.textManager.getTexts()].reverse().find(item => onLayer(item) && contains(item));
      if (text) return { type: 'text', id: text.id };
      const shape = [...this.shapeManager.getShapes()].reverse().find(item => onLayer(item) && (shapeHits.has(item.id) || (item.shapeType !== 'line' && item.shapeType !== 'arrow' && contains(item))));
      if (shape) return { type: 'shape', id: shape.id };
      const stroke = [...this.drawingEngine.getStrokes()].reverse().find(item => onLayer(item) && strokeHits.has(item.id));
      if (stroke) return { type: 'stroke', id: stroke.id };
      const image = [...this.imageManager.getImages()].reverse().find(item => onLayer(item) && contains(item));
      if (image) return { type: 'image', id: image.id };
    }
    return null;
  }

  private internalClipboard = '';
  private lastPastePayload = '';
  private pasteCount = 0;
  private pageScope = 0;

  resetPageScope(): void {
    this.pageScope++;
    this.lastPastePayload = '';
    this.pasteCount = 0;
  }

  pasteInternalClipboard(): boolean {
    if (!this.internalClipboard) return false;
    return this.pasteElements(JSON.parse(this.internalClipboard));
  }

  // ---- Copy / Paste ----

  async copySelection(): Promise<void> {
    if (this.selectedElements.length === 0) return;

    const clipboardData = this.getSelectedElementData();
    if (!clipboardData) return;
    const jsonStr = JSON.stringify(clipboardData);
    this.internalClipboard = jsonStr; // Always store internally for fallback
    this.lastPastePayload = '';
    this.pasteCount = 0;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(jsonStr);
    } catch (e) {
      console.warn('Native clipboard unavailable or failed, using internal clipboard fallback.', e);
    }
  }

  getSelectedElementData(): { type: 'panvas/elements'; strokes: Stroke[]; shapes: any[]; texts: any[]; images: any[] } | null {
    if (this.selectedElements.length === 0) return null;
    const strokesToCopy: Stroke[] = [];
    const shapesToCopy: any[] = [];
    const textsToCopy: any[] = [];
    const imagesToCopy: any[] = [];

    const allStrokes = this.drawingEngine.getStrokes();
    const allShapes = this.shapeManager.getShapes();
    const allTexts = this.textManager.getTexts();
    const allImages = this.imageManager.getImages();

    for (const el of this.selectedElements) {
      if (el.type === 'stroke') {
        const stroke = allStrokes.find(s => s.id === el.id);
        if (stroke) strokesToCopy.push(structuredClone(stroke));
      } else if (el.type === 'shape') {
        const shape = allShapes.find(s => s.id === el.id);
        if (shape) shapesToCopy.push(structuredClone(shape));
      } else if (el.type === 'text') {
        const text = allTexts.find(s => s.id === el.id);
        if (text) textsToCopy.push(structuredClone(text));
      } else if (el.type === 'image') {
        const img = allImages.find(s => s.id === el.id);
        if (img) imagesToCopy.push(structuredClone(img));
      }
    }

    return {
      type: 'panvas/elements' as const,
      strokes: strokesToCopy,
      shapes: shapesToCopy,
      texts: textsToCopy,
      images: imagesToCopy,
    };
  }

  async cutSelection(): Promise<void> {
    await this.copySelection();
    this.deleteSelection();
  }

  selectAll(): void {
    this.clearSelection();
    for (const s of this.drawingEngine.getStrokes()) {
      if (!this.layerManager.isEditable(s.layerId)) continue;
      this.selectedIds.add(s.id);
      this.selectedElements.push({ type: 'stroke', id: s.id });
    }
    for (const sh of this.shapeManager.getShapes()) {
      if (!this.layerManager.isEditable(sh.layerId)) continue;
      this.selectedIds.add(sh.id);
      this.selectedElements.push({ type: 'shape', id: sh.id });
    }
    for (const t of this.textManager.getTexts()) {
      if (!this.layerManager.isEditable(t.layerId)) continue;
      this.selectedIds.add(t.id);
      this.selectedElements.push({ type: 'text', id: t.id });
    }
    for (const img of this.imageManager.getImages()) {
      if (!this.layerManager.isEditable(img.layerId)) continue;
      this.selectedIds.add(img.id);
      this.selectedElements.push({ type: 'image', id: img.id });
    }
    this.notifySelectionChange();
    this.drawingEngine.redraw();
  }

  /** Move selected items to the top of their own layer and render queue. */
  bringToFront(): boolean {
    return this.reorderSelected('front');
  }

  /** Move selected items to the bottom of their own layer and render queue. */
  sendToBack(): boolean {
    return this.reorderSelected('back');
  }

  /** Move selected items one peer forward within their own layer. */
  bringForward(): boolean {
    return this.reorderSelected('forward');
  }

  /** Move selected items one peer backward within their own layer. */
  sendBackward(): boolean {
    return this.reorderSelected('backward');
  }

  /** Replace the current selection with editable objects whose centers are enclosed. */
  selectWithinLoop(points: StrokePoint[]): number {
    const enclosed: SelectedElement[] = [];
    const consider = (element: SelectedElement, layerId?: string) => {
      if (!this.layerManager.isEditable(layerId)) return;
      const box = this.getBoundingBox(element);
      if (!box) return;
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      if (isPointInsideLoop(centerX, centerY, points)) enclosed.push(element);
    };

    this.drawingEngine.getStrokes().forEach(stroke => consider({ type: 'stroke', id: stroke.id }, stroke.layerId));
    this.shapeManager.getShapes().forEach(shape => consider({ type: 'shape', id: shape.id }, shape.layerId));
    this.textManager.getTexts().forEach(text => consider({ type: 'text', id: text.id }, text.layerId));
    this.imageManager.getImages().forEach(image => consider({ type: 'image', id: image.id }, image.layerId));

    if (enclosed.length === 0) return 0;
    this.selectedElements = enclosed;
    this.selectedIds = new Set(enclosed.map(element => element.id));
    this.notifySelectionChange();
    this.drawingEngine.redraw();
    return enclosed.length;
  }

  async duplicateSelection(): Promise<void> {
    const snapshot = this.getSelectedElementData();
    if (snapshot) this.pasteElements(snapshot);
  }

  pasteElements(data: any, placement?: { x: number; y: number }, onChange?: () => void): boolean {
    const snapshot = validateElementSnapshot(data);
    if (!snapshot || !this.layerManager.isEditable(this.layerManager.getActiveLayerId())) return false;
    data = snapshot;
    const payload = JSON.stringify(snapshot);
    this.pasteCount = payload === this.lastPastePayload ? this.pasteCount + 1 : 1;
    this.lastPastePayload = payload;
    const points = [...snapshot.strokes.flatMap(stroke => stroke.points), ...snapshot.shapes, ...snapshot.texts, ...snapshot.images];
    const dx = placement ? placement.x - Math.min(...points.map(point => point.x)) : 20 * this.pasteCount;
    const dy = placement ? placement.y - Math.min(...points.map(point => point.y)) : 20 * this.pasteCount;

    const newStrokes: Stroke[] = [];
    const newShapes: any[] = [];
    const newTexts: any[] = [];
    const newImages: any[] = [];
    const targetLayerId = (_sourceLayerId?: string) => this.layerManager.getActiveLayerId();

    this.clearSelection();

    if (data.strokes) {
      for (const s of data.strokes) {
        const newStroke = { ...s, id: generateId('strk'), layerId: targetLayerId(s.layerId) };
        newStroke.points = newStroke.points.map((p: any) => ({ ...p, x: p.x + dx, y: p.y + dy }));
        newStrokes.push(newStroke);
      }
    }

    if (data.shapes) {
      for (const s of data.shapes) {
        const newShape = { ...s, id: generateId('shp'), layerId: targetLayerId(s.layerId), x: s.x + dx, y: s.y + dy };
        newShapes.push(newShape);
      }
    }

    if (data.texts) {
      for (const t of data.texts) {
        const newText = { ...t, id: generateId('txt'), layerId: targetLayerId(t.layerId), x: t.x + dx, y: t.y + dy };
        newTexts.push(newText);
      }
    }

    if (data.images) {
      for (const img of data.images) {
        const newImg = { ...img, id: generateId('img'), layerId: targetLayerId(img.layerId), x: img.x + dx, y: img.y + dy };
        newImages.push(newImg);
      }
    }

    if (newStrokes.length === 0 && newShapes.length === 0 && newTexts.length === 0 && newImages.length === 0) return false;

    this.historyManager.push({
      description: 'Paste elements',
      execute: () => {
        newStrokes.forEach(s => this.drawingEngine.addStroke(s));
        newShapes.forEach(s => this.shapeManager.addShape(s));
        newTexts.forEach(t => this.textManager.addText(t));
        newImages.forEach(i => this.imageManager.addImage(i));

        this.clearSelection();
        newStrokes.forEach(s => {
          this.selectedElements.push({ type: 'stroke', id: s.id });
          this.selectedIds.add(s.id);
        });
        newShapes.forEach(s => {
          this.selectedElements.push({ type: 'shape', id: s.id });
          this.selectedIds.add(s.id);
        });
        newTexts.forEach(s => {
          this.selectedElements.push({ type: 'text', id: s.id });
          this.selectedIds.add(s.id);
        });
        newImages.forEach(s => {
          this.selectedElements.push({ type: 'image', id: s.id });
          this.selectedIds.add(s.id);
        });
        this.notifySelectionChange();
        this.drawingEngine.redraw();
        onChange?.();
      },
      undo: () => {
        this.clearSelection();
        const strokeIds = new Set(newStrokes.map(s => s.id));
        const shapeIds = new Set(newShapes.map(s => s.id));
        const textIds = new Set(newTexts.map(s => s.id));
        const imageIds = new Set(newImages.map(s => s.id));
        this.drawingEngine.removeStrokes(strokeIds);
        this.shapeManager.removeShapes(shapeIds);
        this.textManager.removeTexts(textIds);
        this.imageManager.removeImages(imageIds);
        this.drawingEngine.redraw();
        onChange?.();
      }
    });

    return true;
  }

  async pasteSelection(): Promise<void> {
    const scope = this.pageScope;
    try {
      let text = '';
      if (navigator.clipboard) {
        text = await navigator.clipboard.readText();
      }
      if (scope !== this.pageScope) return;

      if (!text) { this.pasteInternalClipboard(); return; }

      try {
        const data = JSON.parse(text);
        if (data?.type === 'panvas/elements') {
          this.pasteElements(data);
        }
      } catch {
        // Not JSON / not panvas elements
      }
    } catch (e) {
      if (scope === this.pageScope) this.pasteInternalClipboard();
      console.error('Failed to paste from clipboard', e);
    }
  }

  // ---- Dragging & Resizing ----

  startDrag(x: number, y: number): void {
    if (this.selectedElements.length === 0) return;
    this.isDragging = true;
    this.dragStartX = x;
    this.dragStartY = y;
    this.originalPositions.clear();
    this.originalInkClips.clear();

    const handleHit = this.getHandleAt(x, y);
    this.dragMode = handleHit ? handleHit.handle : 'move';
    // We can only resize one element at a time currently
    if (this.dragMode !== 'move' && this.selectedElements.length === 1) {
      this.originalBox = this.getBoundingBox(this.selectedElements[0]);
    } else {
      // Force move if multiple selected
      this.dragMode = 'move';
      this.originalBox = null;
    }
    if (this.dragMode === 'rotate' && this.originalBox) {
      const center = { x: this.originalBox.x + this.originalBox.width / 2, y: this.originalBox.y + this.originalBox.height / 2 };
      this.rotationStartAngle = Math.atan2(y - center.y, x - center.x);
    }

    // Snapshot original positions for undo
    for (const el of this.selectedElements) {
      if (el.type === 'shape') {
        const shape = this.shapeManager.getShapes().find(s => s.id === el.id);
        if (shape) {
          this.originalPositions.set(el.id, { x: shape.x, y: shape.y, width: shape.width, height: shape.height, rotation: shape.rotation ?? 0 });
        }
      } else if (el.type === 'text') {
        const text = this.textManager.getTexts().find(t => t.id === el.id);
        if (text) {
          this.originalPositions.set(el.id, { x: text.x, y: text.y, width: text.width, height: text.height, rotation: text.rotation ?? 0 });
        }
      } else if (el.type === 'image') {
        const img = this.imageManager.getImages().find(i => i.id === el.id);
        if (img) {
          this.originalPositions.set(el.id, { x: img.x, y: img.y, width: img.width, height: img.height, rotation: img.rotation });
        }
      } else {
        const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
        if (stroke) {
          // Deep copy points
          this.originalPositions.set(el.id, stroke.points.map(p => ({ ...p })));
          this.originalInkClips.set(el.id, stroke.inkClip ? structuredClone(stroke.inkClip) : undefined);
        }
      }
    }
  }

  dragTo(x: number, y: number): void {
    if (!this.isDragging) return;

    if (this.dragMode === 'move') {
      const dx = x - this.dragStartX;
      const dy = y - this.dragStartY;

      for (const el of this.selectedElements) {
        const orig = this.originalPositions.get(el.id);
        if (!orig) continue;
        const object = this.getObject(el);
        if (object) applyGroupedTranslation(object, orig, dx, dy);
      }
    } else if (this.originalBox && this.selectedElements.length === 1) {
      // 8-Handle Resize logic
      const dx = x - this.dragStartX;
      const dy = y - this.dragStartY;
      const el = this.selectedElements[0];
      const origPos = this.originalPositions.get(el.id);
      if (!origPos) return;

      const origX = origPos.x ?? 0;
      const origY = origPos.y ?? 0;
      const origW = origPos.width ?? 100;
      const origH = origPos.height ?? 40;

      if (this.dragMode === 'rotate') {
        const object = this.getObject(el) as (MixedPlacementObject & { rotation?: number }) | undefined;
        if (object) {
          const center = { x: this.originalBox.x + this.originalBox.width / 2, y: this.originalBox.y + this.originalBox.height / 2 };
          const delta = (Math.atan2(y - center.y, x - center.x) - this.rotationStartAngle) * 180 / Math.PI;
          object.rotation = ((origPos.rotation ?? 0) + delta + 360) % 360;
        }
        this.drawingEngine.redraw();
        return;
      }

      if (el.type === 'text' || el.type === 'shape' || el.type === 'image') {
        const object = this.getObject(el) as { x: number; y: number; width: number; height?: number; rotation?: number } | undefined;
        if (object) this.resizeRotatedBox(object, origPos, this.dragMode, dx, dy, el.type === 'text' ? 40 : el.type === 'image' ? 20 : 10);
        this.drawingEngine.redraw();
        return;
      }

      {
        const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
        if (stroke && this.originalBox) {
          const box = this.originalBox;
          let scaleX = 1;
          let scaleY = 1;
          let transX = box.x;
          let transY = box.y;

          if (this.dragMode === 'br') {
            scaleX = (box.width + dx) / box.width;
            scaleY = (box.height + dy) / box.height;
          } else if (this.dragMode === 'bl') {
            scaleX = (box.width - dx) / box.width;
            scaleY = (box.height + dy) / box.height;
            transX = box.x + box.width;
          } else if (this.dragMode === 'tr') {
            scaleX = (box.width + dx) / box.width;
            scaleY = (box.height - dy) / box.height;
            transY = box.y + box.height;
          } else if (this.dragMode === 'tl') {
            scaleX = (box.width - dx) / box.width;
            scaleY = (box.height - dy) / box.height;
            transX = box.x + box.width;
            transY = box.y + box.height;
          }

          if (Math.abs(scaleX) < 0.05) scaleX = 0.05 * Math.sign(scaleX) || 0.05;
          if (Math.abs(scaleY) < 0.05) scaleY = 0.05 * Math.sign(scaleY) || 0.05;

          for (let i = 0; i < stroke.points.length; i++) {
            stroke.points[i].x = transX + (origPos[i].x - transX) * scaleX;
            stroke.points[i].y = transY + (origPos[i].y - transY) * scaleY;
          }
          const originalClip = this.originalInkClips.get(el.id);
          stroke.inkClip = originalClip?.map(polygon => polygon.map(ring => ring.map(([clipX, clipY]) => [clipX * scaleX, clipY * scaleY])));
        }
      }
    }

    this.drawingEngine.redraw();
  }

  finishDrag(x: number, y: number): boolean {
    if (!this.isDragging) return false;
    this.isDragging = false;

    const dx = x - this.dragStartX;
    const dy = y - this.dragStartY;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return false;

    const elements = [...this.selectedElements];
    const origMap = new Map(this.originalPositions);
    const originalInkClips = new Map(this.originalInkClips);
    const finalInkClips = new Map<string, Stroke['inkClip']>();

    // Create deep copy of new state to save in history
    const finalMap = new Map();
    for (const el of elements) {
      if (el.type === 'shape') {
        const shape = this.shapeManager.getShapes().find(s => s.id === el.id);
        if (shape) {
          finalMap.set(el.id, { x: shape.x, y: shape.y, width: shape.width, height: shape.height, rotation: shape.rotation ?? 0 });
        }
      } else if (el.type === 'text') {
        const text = this.textManager.getTexts().find(t => t.id === el.id);
        if (text) {
          finalMap.set(el.id, { x: text.x, y: text.y, width: text.width, height: text.height, rotation: text.rotation ?? 0 });
        }
      } else if (el.type === 'image') {
        const image = this.imageManager.getImages().find(item => item.id === el.id);
        if (image) {
          finalMap.set(el.id, { x: image.x, y: image.y, width: image.width, height: image.height, rotation: image.rotation });
        }
      } else {
        const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
        if (stroke) {
          finalMap.set(el.id, stroke.points.map(p => ({ ...p })));
          finalInkClips.set(el.id, stroke.inkClip ? structuredClone(stroke.inkClip) : undefined);
        }
      }
    }

    this.historyManager.pushExecuted({
      description: this.dragMode === 'move' ? 'Move elements' : 'Resize element',
      execute: () => {
        for (const el of elements) {
          const finalState = finalMap.get(el.id);
          if (!finalState) continue;
          if (el.type === 'shape') {
            const shape = this.shapeManager.getShapes().find(s => s.id === el.id);
            if (shape) {
              shape.x = finalState.x;
              shape.y = finalState.y;
              shape.width = finalState.width;
              shape.height = finalState.height;
              shape.rotation = finalState.rotation;
            }
          } else if (el.type === 'text') {
            const text = this.textManager.getTexts().find(t => t.id === el.id);
            if (text) {
              text.x = finalState.x;
              text.y = finalState.y;
              text.width = finalState.width;
              text.height = finalState.height;
              text.rotation = finalState.rotation;
            }
          } else if (el.type === 'image') {
            const image = this.imageManager.getImages().find(item => item.id === el.id);
            if (image) {
              image.x = finalState.x;
              image.y = finalState.y;
              image.width = finalState.width;
              image.height = finalState.height;
              image.rotation = finalState.rotation;
            }
          } else {
            const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
            if (stroke) {
              for (let i = 0; i < stroke.points.length; i++) {
                stroke.points[i].x = finalState[i].x;
                stroke.points[i].y = finalState[i].y;
              }
              stroke.inkClip = finalInkClips.get(el.id) ? structuredClone(finalInkClips.get(el.id)) : undefined;
            }
          }
        }
        this.drawingEngine.redraw();
      },
      undo: () => {
        for (const el of elements) {
          const orig = origMap.get(el.id);
          if (!orig) continue;
          if (el.type === 'shape') {
            const shape = this.shapeManager.getShapes().find(s => s.id === el.id);
            if (shape) {
              shape.x = orig.x;
              shape.y = orig.y;
              shape.width = orig.width;
              shape.height = orig.height;
              shape.rotation = orig.rotation;
            }
          } else if (el.type === 'text') {
            const text = this.textManager.getTexts().find(t => t.id === el.id);
            if (text) {
              text.x = orig.x;
              text.y = orig.y;
              text.width = orig.width;
              text.height = orig.height;
              text.rotation = orig.rotation;
            }
          } else if (el.type === 'image') {
            const image = this.imageManager.getImages().find(item => item.id === el.id);
            if (image) {
              image.x = orig.x;
              image.y = orig.y;
              image.width = orig.width;
              image.height = orig.height;
              image.rotation = orig.rotation;
            }
          } else {
            const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
            if (stroke) {
              for (let i = 0; i < stroke.points.length; i++) {
                stroke.points[i].x = orig[i].x;
                stroke.points[i].y = orig[i].y;
              }
              const originalClip = originalInkClips.get(el.id);
              stroke.inkClip = originalClip ? structuredClone(originalClip) : undefined;
            }
          }
        }
        this.drawingEngine.redraw();
      }
    });

    return true;
  }

  // ---- Rendering Selection Bounding Boxes ----

  private selectionControlsVisible = true;

  private usesStickyDomControls(): boolean {
    const selected = this.selectedElements;
    return selected.length === 1 && selected[0].type === 'text'
      && this.textManager.getTexts().some(text => text.id === selected[0].id && text.metadata?.isStickyNote === true);
  }

  setSelectionControlsVisible(visible: boolean): void {
    this.selectionControlsVisible = visible;
    this.drawingEngine.redraw();
  }

  renderSelection(ctx: CanvasRenderingContext2D): void {
    if (!this.selectionControlsVisible) return;
    if (this.selectedElements.length === 0) return;

    // A single sticky retains logical selection, clipboard and history ownership.
    // Its DOM surface owns visible handles; mixed selections use this painter.
    if (this.usesStickyDomControls()) return;

    ctx.save();
    this.viewport.applyTransform(ctx);

    const scale = this.viewport.getState().scale;

    ctx.strokeStyle = '#3b82f6'; // Panvas blue
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([5 / scale, 5 / scale]);

    for (const el of this.selectedElements) {
      const box = this.getBoundingBox(el);
      if (box) {
        const rotation = this.getObjectRotation(el) * Math.PI / 180;
        const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        ctx.save();
        ctx.translate(center.x, center.y);
        ctx.rotate(rotation);
        ctx.translate(-center.x, -center.y);
        ctx.strokeRect(box.x - 4, box.y - 4, box.width + 8, box.height + 8);

        // Draw 8 resize handles
        ctx.fillStyle = '#ffffff';
        ctx.setLineDash([]);
        const handleSize = 8 / scale;
        const h2 = handleSize / 2;
        const midX = box.x + box.width / 2;
        const midY = box.y + box.height / 2;

        const handles = [
          { x: box.x - 4, y: box.y - 4 },
          { x: midX, y: box.y - 4 },
          { x: box.x + box.width + 4, y: box.y - 4 },
          { x: box.x - 4, y: midY },
          { x: box.x + box.width + 4, y: midY },
          { x: box.x - 4, y: box.y + box.height + 4 },
          { x: midX, y: box.y + box.height + 4 },
          { x: box.x + box.width + 4, y: box.y + box.height + 4 }
        ];

        for (const c of handles) {
          ctx.strokeRect(c.x - h2, c.y - h2, handleSize, handleSize);
          ctx.fillRect(c.x - h2, c.y - h2, handleSize, handleSize);
        }
        ctx.beginPath();
        ctx.moveTo(midX, box.y - 4);
        ctx.lineTo(midX, box.y - 32 / scale);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(midX, box.y - 32 / scale, 5 / scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        ctx.setLineDash([5 / scale, 5 / scale]); // restore
      }
    }

    ctx.restore();
  }

  private reorderSelected(action: ZOrderAction): boolean {
    if (this.selectedElements.length === 0) return false;

    const before = this.getObjectOrderSnapshot();
    const selectedIds = new Set(this.selectedElements.map(element => element.id));
    const editableIds = <T extends { id: string; layerId?: string }>(items: T[]) => new Set(
      items
        .filter(item => selectedIds.has(item.id) && this.layerManager.isEditable(item.layerId))
        .map(item => item.id),
    );
    const next: ObjectOrderSnapshot = {
      strokes: reorderQueueWithinLayers(before.strokes, editableIds(before.strokes), action),
      shapes: reorderQueueWithinLayers(before.shapes, editableIds(before.shapes), action),
      texts: reorderQueueWithinLayers(before.texts, editableIds(before.texts), action),
      images: reorderQueueWithinLayers(before.images, editableIds(before.images), action),
    };

    if (!this.objectOrderChanged(before, next)) return false;
    this.applyObjectOrder(next);
    this.historyManager.pushExecuted({
      description: `Arrange ${action}`,
      execute: () => this.applyObjectOrder(next),
      undo: () => this.applyObjectOrder(before),
    });
    return true;
  }

  private getObjectOrderSnapshot(): ObjectOrderSnapshot {
    return {
      strokes: [...this.drawingEngine.getStrokes()],
      shapes: [...this.shapeManager.getShapes()],
      texts: [...this.textManager.getTexts()],
      images: [...this.imageManager.getImages()],
    };
  }

  private applyObjectOrder(order: ObjectOrderSnapshot): void {
    const replace = <T>(target: T[], next: T[]) => target.splice(0, target.length, ...next);
    replace(this.drawingEngine.getStrokes(), order.strokes);
    replace(this.shapeManager.getShapes(), order.shapes);
    replace(this.textManager.getTexts(), order.texts);
    replace(this.imageManager.getImages(), order.images);
    this.drawingEngine.redraw();
  }

  private objectOrderChanged(before: ObjectOrderSnapshot, next: ObjectOrderSnapshot): boolean {
    return [
      [before.strokes, next.strokes],
      [before.shapes, next.shapes],
      [before.texts, next.texts],
      [before.images, next.images],
    ].some(([previous, current]) => previous.some((item, index) => item.id !== current[index]?.id));
  }

  private getObject(element: SelectedElement): MixedPlacementObject | undefined {
    if (element.type === 'stroke') {
      return this.drawingEngine.getStrokes().find(item => item.id === element.id);
    }
    if (element.type === 'shape') {
      return this.shapeManager.getShapes().find(item => item.id === element.id);
    }
    if (element.type === 'text') {
      return this.textManager.getTexts().find(item => item.id === element.id);
    }
    return this.imageManager.getImages().find(item => item.id === element.id);
  }

  private getObjectRotation(element: SelectedElement): number {
    const object = this.getObject(element) as { rotation?: number } | undefined;
    return object?.rotation ?? 0;
  }

  private resizeRotatedBox(object: { x: number; y: number; width: number; height?: number; rotation?: number }, original: any, handle: Exclude<ResizeHandle, null | 'rotate'>, worldDx: number, worldDy: number, minimum: number): void {
    const angle = (original.rotation ?? 0) * Math.PI / 180;
    const dx = worldDx * Math.cos(angle) + worldDy * Math.sin(angle);
    const dy = -worldDx * Math.sin(angle) + worldDy * Math.cos(angle);
    const affectsLeft = handle.includes('l'), affectsRight = handle.includes('r');
    const affectsTop = handle.includes('t'), affectsBottom = handle.includes('b');
    const widthDelta = affectsRight ? dx : affectsLeft ? -dx : 0;
    const heightDelta = affectsBottom ? dy : affectsTop ? -dy : 0;
    const width = Math.max(minimum, original.width + widthDelta);
    const height = Math.max(minimum, (original.height ?? 40) + heightDelta);
    const appliedWidthDelta = width - original.width;
    const appliedHeightDelta = height - (original.height ?? 40);
    const localShiftX = affectsRight ? appliedWidthDelta / 2 : affectsLeft ? -appliedWidthDelta / 2 : 0;
    const localShiftY = affectsBottom ? appliedHeightDelta / 2 : affectsTop ? -appliedHeightDelta / 2 : 0;
    const centerX = original.x + original.width / 2 + localShiftX * Math.cos(angle) - localShiftY * Math.sin(angle);
    const centerY = original.y + (original.height ?? 40) / 2 + localShiftX * Math.sin(angle) + localShiftY * Math.cos(angle);
    object.x = centerX - width / 2;
    object.y = centerY - height / 2;
    object.width = width;
    object.height = height;
  }

  private getBoundingBox(el: SelectedElement): BoundingBox | null {
    if (el.type === 'shape') {
      const shape = this.shapeManager.getShapes().find(s => s.id === el.id);
      if (!shape) return null;
      return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
    } else if (el.type === 'text') {
      const text = this.textManager.getTexts().find(t => t.id === el.id);
      if (!text) return null;
      return { x: text.x, y: text.y, width: text.width, height: text.height || 100 };
    } else if (el.type === 'image') {
      const img = this.imageManager.getImages().find(i => i.id === el.id);
      if (!img) return null;
      return { x: img.x, y: img.y, width: img.width, height: img.height };
    } else {
      const stroke = this.drawingEngine.getStrokes().find(s => s.id === el.id);
      if (!stroke || stroke.points.length === 0) return null;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of stroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
  }
}
