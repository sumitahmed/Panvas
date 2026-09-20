// ============================================
// Panvas — Notebook Engine (Orchestrator)
// ============================================
// Ties all managers together into one notebook engine instance.
// React components interact with this single object.

import type { DrawingData, Stroke, Shape, PageProperties, NotebookObject, TextObject } from './drawingTypes';
import { createEmptyDrawingData, DEFAULT_PAGE_LAYER_ID } from './drawingTypes';
import { ViewportManager } from './ViewportManager';
import { ToolManager } from './ToolManager';
import { HistoryManager } from './HistoryManager';
import { DrawingEngine } from './DrawingEngine';
import { EraserEngine } from './EraserEngine';
import { cloneStrokeSnapshot } from './cloneStrokeSnapshot.ts';
import { ShapeManager } from './ShapeManager';
import { TextManager } from './TextManager';
import { ImageManager } from './ImageManager';
import { SelectionEngine } from './SelectionEngine';
import { InputManager } from './InputManager';
import { LayerManager } from './LayerManager';
import { AudioNoteManager } from './AudioNoteManager';
import type { RulerManager } from './RulerManager.ts';
import type { LaserManager } from './LaserManager.ts';
import {
  createBeautifiedTextPlacement,
  createHandwritingTipTapContent,
  type ExistingHandwritingLinePlacement,
  type HandwritingToolPreferences,
} from '@/services/beautification/handwritingBeautification';
import { generateId } from '@/lib/utils/id';
import { resolvePageDimensions } from '@/lib/pageProperties';
import { getHandwritingRecognitionProvider } from '@/services/recognition';
import type { HandwritingRecognitionProvider } from '@/services/recognition/types';
import {
  createHandwritingConversionCommand,
} from '@/services/recognition/conversion';
import {
  createBulkHandwritingLinePlacements,
  type ReviewedHandwritingLine,
} from '@/services/recognition/bulkConversion';
import {
  RealTimeHandwritingSession,
  type HandwritingRecognitionCommit,
} from '@/services/recognition/RealTimeHandwritingSession';
import type { PagePropertyChangeSource } from '../notebookPageRenderState';
import { gate0Profiler } from '../../../dev/gate0Profiler.ts';
import { SceneMutationCoordinator } from './sceneMutationCoordinator';

export interface NotebookEngineOptions {
  recognitionProvider?: HandwritingRecognitionProvider;
}

function existingHandwritingLines(texts: readonly TextObject[], layerId: string | undefined): ExistingHandwritingLinePlacement[] {
  return texts.flatMap(text => {
    const metadata = text.metadata;
    const sourceBounds = metadata?.sourceBounds as Partial<ExistingHandwritingLinePlacement['sourceBounds']> | undefined;
    const sourceBaseline = metadata?.sourceBaseline;
    const lineHeight = metadata?.handwritingLineHeight;
    if (
      metadata?.generatedFrom !== 'handwriting-recognition'
      || text.layerId !== layerId
      || !sourceBounds
      || !Number.isFinite(sourceBounds.x)
      || !Number.isFinite(sourceBounds.y)
      || !Number.isFinite(sourceBounds.width)
      || !Number.isFinite(sourceBounds.height)
      || !Number.isFinite(sourceBaseline)
      || !Number.isFinite(lineHeight)
    ) return [];
    return [{
      x: text.x,
      y: text.y,
      width: text.width,
      lineHeight: lineHeight as number,
      sourceBounds: sourceBounds as ExistingHandwritingLinePlacement['sourceBounds'],
      sourceBaseline: sourceBaseline as number,
    }];
  });
}

export class NotebookEngine {
  readonly viewport: ViewportManager;
  readonly tools: ToolManager;
  readonly history: HistoryManager;
  readonly drawing: DrawingEngine;
  readonly eraser: EraserEngine;
  readonly shapes: ShapeManager;
  readonly texts: TextManager;
  readonly images: ImageManager;
  readonly selection: SelectionEngine;
  readonly input: InputManager;
  readonly layers: LayerManager;
  readonly audio: AudioNoteManager;
  readonly ruler: RulerManager;
  readonly laser: LaserManager;
  readonly handwriting: RealTimeHandwritingSession;

  private properties: PageProperties;
  private sceneOwnerPageId: string | null = null;
  private drawingRevision = 0;
  private propertiesListeners: Set<(props: Readonly<PageProperties>, source: PagePropertyChangeSource) => void> = new Set();
  private unsubscribeHandwritingLifecycle: (() => void) | null = null;
  private unsubscribeHandwritingTool: (() => void) | null = null;
  private unsubscribeDrawingRevision: (() => void) | null = null;
  private unsubscribeHistoryRevision: (() => void) | null = null;
  private sceneMutations = new SceneMutationCoordinator();
  private sceneMutationListeners = new Set<() => void>();

  constructor(options: NotebookEngineOptions = {}) {
    this.viewport = new ViewportManager();
    this.tools = new ToolManager();
    this.history = new HistoryManager();
    this.layers = new LayerManager();
    this.audio = new AudioNoteManager();
    this.shapes = new ShapeManager(this.viewport, this.layers);
    this.texts = new TextManager(this.layers);
    this.images = new ImageManager(this.viewport, this.layers);
    this.drawing = new DrawingEngine(this.viewport, this.shapes, this.images, this.layers);
    this.ruler = this.drawing.getRulerManager();
    this.laser = this.drawing.getLaserManager();
    this.eraser = new EraserEngine(this.drawing, this.history);
    this.eraser.setShapeManager(this.shapes);
    this.selection = new SelectionEngine(this.drawing, this.shapes, this.history, this.viewport, this.texts, this.images, this.layers);
    this.drawing.setSelectionEngine(this.selection);
    this.input = new InputManager(this.tools, this.viewport, this.drawing, this.eraser, this.shapes, this.selection, this.history, this.texts, this.ruler, this.laser);
    this.handwriting = new RealTimeHandwritingSession(
      options.recognitionProvider ?? getHandwritingRecognitionProvider(),
      conversion => this.commitRecognizedHandwriting(conversion),
      strokes => {
        const current = new Map(this.drawing.getStrokes().map(stroke => [stroke.id, stroke]));
        return strokes.every(source => {
          const candidate = current.get(source.id);
          return candidate !== undefined && JSON.stringify(candidate) === JSON.stringify(source);
        });
      },
    );
    this.unsubscribeHandwritingLifecycle = this.input.onInkStrokeLifecycle(event => {
      if (event.type === 'start') this.handwriting.beginStroke();
      else if (event.type === 'cancel') this.handwriting.cancelStroke();
      else this.handwriting.completeStroke(event.stroke);
    });
    this.unsubscribeHandwritingTool = this.tools.subscribe(state => {
      this.handwriting.setActive(state.handwritingToTextEnabled);
    });
    this.unsubscribeDrawingRevision = this.input.onDrawingChange(() => {
      this.publishSceneMutation('drawing');
    });
    this.unsubscribeHistoryRevision = this.history.subscribe((_canUndo, _canRedo, source) => {
      if (source === 'user') {
        this.publishSceneMutation('history');
      }
    });
    this.properties = createEmptyDrawingData().properties;
    
    // Wire up redraw callback
    this.images.setRedrawCallback(() => this.drawing.redraw());
    this.layers.subscribe(() => {
      this.selection.clearSelection();
      this.drawing.redraw();
    });
  }

  // ---- Canvas Lifecycle ----

  /** Bind the engine to a canvas element. Call once after the canvas mounts. */
  mount(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): void {
    // React Strict Mode replays effect cleanup/setup against the same engine.
    // Restore the owned listeners that destroy() released.
    this.handwriting.revive();
    if (!this.unsubscribeHandwritingLifecycle) {
      this.unsubscribeHandwritingLifecycle = this.input.onInkStrokeLifecycle(event => {
        if (event.type === 'start') this.handwriting.beginStroke();
        else if (event.type === 'cancel') this.handwriting.cancelStroke();
        else this.handwriting.completeStroke(event.stroke);
      });
    }
    if (!this.unsubscribeHandwritingTool) {
      this.unsubscribeHandwritingTool = this.tools.subscribe(state => {
        this.handwriting.setActive(state.handwritingToTextEnabled);
      });
      this.handwriting.setActive(this.tools.getState().handwritingToTextEnabled);
    }
    if (!this.unsubscribeDrawingRevision) {
      this.unsubscribeDrawingRevision = this.input.onDrawingChange(() => {
        this.publishSceneMutation('drawing');
      });
    }
    if (!this.unsubscribeHistoryRevision) {
      this.unsubscribeHistoryRevision = this.history.subscribe((_canUndo, _canRedo, source) => {
        if (source === 'user') this.publishSceneMutation('history');
      });
    }
    this.drawing.setCanvas(canvas, cssWidth, cssHeight);
    this.input.attach(canvas);
    this.drawing.redraw();
  }

  /** Unbind input and detach canvas from a canvas remount. */
  unmount(): void {
    this.handwriting.invalidateScope();
    this.input.detach();
    this.drawing.detachCanvas();
  }

  /** Handle canvas resize. */
  resize(cssWidth: number, cssHeight: number): void {
    this.drawing.resize(cssWidth, cssHeight);
  }

  // ---- Data Serialization ----

  /** Get all drawing data for persistence. */
  getDrawingData(): DrawingData {
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    const captured: DrawingData = structuredClone({
      version: 3,
      objects: [
        ...this.shapes.getShapes(),
        ...this.texts.getTexts(),
        ...this.images.getImages(),
      ],
      layers: this.layers.getLayers().map(layer => ({ ...layer })),
      activeLayerId: this.layers.getActiveLayerId(),
      audioNotes: this.audio.getAll().map(note => ({ ...note })),
      properties: { ...this.properties },
    });
    captured.objects = [...this.drawing.getStrokes().map(cloneStrokeSnapshot), ...captured.objects!];
    if (startedAt) {
      const duration = performance.now() - startedAt;
      gate0Profiler.event('get-drawing-data', duration, {
        objects: captured.objects?.length ?? 0,
      });
    }
    return captured;
  }

  getDrawingOwnership(): Readonly<{ pageId: string | null; revision: number }> {
    return { pageId: this.sceneOwnerPageId, revision: this.drawingRevision };
  }

  /** One notification per logical committed scene mutation. */
  onSceneMutation(listener: () => void): () => void {
    this.sceneMutationListeners.add(listener);
    return () => this.sceneMutationListeners.delete(listener);
  }

  onDrawingGestureLifecycle(listener: (active: boolean) => void): () => void {
    return this.input.onDrawingGestureLifecycle(listener);
  }

  private publishSceneMutation(channel: 'drawing' | 'history'): void {
    // Commands can intentionally notify both managers in one stack. The first channel is
    // the committed boundary; its paired compatibility notification is not a new mutation.
    // Snapshot listeners still run synchronously here, before any mutable state can drift.
    if (!this.sceneMutations.accept(channel)) return;
    this.drawingRevision += 1;
    this.sceneMutationListeners.forEach(listener => listener());
  }

  /** Load drawing data (e.g., from disk). Replaces current state. */
  setDrawingData(data: DrawingData | null, pageId: string | null = null): void {
    this.input.setEraserPageOwner(pageId);
    const ownedData = data ? structuredClone(data) : null;
    this.sceneOwnerPageId = pageId;
    this.drawingRevision += 1;
    this.selection.resetPageScope();
    this.handwriting.setPageId(pageId);
    if (!ownedData) {
      this.layers.setData(undefined, undefined);
      this.audio.setAll(undefined);
      this.drawing.setStrokes([]);
      this.shapes.setShapes([]);
      this.texts.setTexts([]);
      this.images.clearImages();
      this.properties = createEmptyDrawingData().properties;
    } else {
      this.layers.setData(ownedData.layers, ownedData.activeLayerId);
      this.audio.setAll(ownedData.audioNotes);
      const validLayerIds = new Set(this.layers.getLayers().map(layer => layer.id));
      const fallbackLayerId = validLayerIds.has(DEFAULT_PAGE_LAYER_ID)
        ? DEFAULT_PAGE_LAYER_ID
        : this.layers.getLayers()[0].id;
      const normalizeLayer = <T extends NotebookObject>(object: T): T => ({
        ...object,
        layerId: object.layerId && validLayerIds.has(object.layerId) ? object.layerId : fallbackLayerId,
      });
      if (ownedData.version === 1) {
        this.drawing.setStrokes((ownedData.strokes || []).map(normalizeLayer));
        this.shapes.setShapes((ownedData.shapes || []).map(normalizeLayer));
        this.texts.setTexts([]);
        this.images.clearImages();
      } else {
        const objects = (ownedData.objects || []).map(normalizeLayer);
        this.drawing.setStrokes(objects.filter(o => o.type === 'stroke') as Stroke[]);
        this.shapes.setShapes(objects.filter(o => o.type === 'shape') as Shape[]);
        this.texts.setTexts(objects.filter(o => o.type === 'text') as any[]);
        this.images.setImages(objects.filter(o => o.type === 'image') as any[]);
      }
      this.properties = { ...createEmptyDrawingData().properties, ...(ownedData.properties || {}) };
    }
    const dimensions = resolvePageDimensions(this.properties);
    this.ruler.setMaxLength(Math.max(dimensions.width, dimensions.height));
    this.history.clear();
    this.drawing.redraw();
    this.notifyPropertiesChange('load');
  }

  /** Remove a layer while preserving its objects on the nearest editable layer. */
  removeLayer(layerId: string): boolean {
    const result = this.layers.remove(layerId);
    if (!result) return false;
    const move = <T extends { layerId?: string }>(items: T[]) => {
      items.forEach(item => { if (item.layerId === layerId) item.layerId = result.fallbackId; });
    };
    move(this.drawing.getStrokes());
    move(this.shapes.getShapes());
    move(this.texts.getTexts());
    move(this.images.getImages());
    this.drawing.redraw();
    return true;
  }

  // ---- Selection arrangement ----

  bringSelectionToFront(): boolean {
    return this.selection.bringToFront();
  }

  sendSelectionToBack(): boolean {
    return this.selection.sendToBack();
  }

  bringSelectionForward(): boolean {
    return this.selection.bringForward();
  }

  sendSelectionBackward(): boolean {
    return this.selection.sendBackward();
  }

  /** Commit all user-reviewed lines as one atomic selected-ink conversion. */
  convertSelectedHandwritingLinesToText(
    lines: readonly ReviewedHandwritingLine[],
    preferences: HandwritingToolPreferences,
    providerId: string,
  ): boolean {
    if (lines.length === 0 || lines.some(line => !line.text.trim())) return false;
    const sourceStrokes = lines.flatMap(line => line.strokes).filter((stroke, index, values) => (
      values.findIndex(candidate => candidate.id === stroke.id) === index
    ));
    const placements = createBulkHandwritingLinePlacements(
      lines,
      preferences,
      line => existingHandwritingLines(this.texts.getTexts(), line.layerId),
    );
    if (placements.length !== lines.length) return false;

    const conversionId = generateId('handwriting-bulk');
    const createdAt = Date.now();
    const textObjects: TextObject[] = placements.map(({ line, placement }, lineIndex) => ({
      id: generateId('txt'),
      type: 'text',
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      content: createHandwritingTipTapContent(line.text.trim(), {
        fontFamily: preferences.fontFamily,
        fontSize: placement.fontSize,
        color: preferences.color,
      }),
      createdAt: createdAt + lineIndex,
      layerId: line.layerId ?? this.layers.getActiveLayerId(),
      metadata: {
        generatedFrom: 'handwriting-recognition',
        recognitionProvider: providerId,
        recognitionLanguage: line.language ?? (preferences.language || undefined),
        recognitionBatchId: `${conversionId}-line-${lineIndex + 1}`,
        handwritingLineId: `${conversionId}-line-${lineIndex + 1}`,
        bulkConversionId: conversionId,
        bulkLineIndex: lineIndex,
        bulkLineCount: lines.length,
        blankLinesBefore: line.blankLinesBefore,
        sourceStrokeIds: line.strokes.map(stroke => stroke.id),
        sourceBounds: line.bounds,
        sourceBaseline: placement.baseline,
        sourceLineHeight: line.bounds.height,
        sourceLeftX: line.bounds.x,
        sourceRightX: line.bounds.x + line.bounds.width,
        handwritingLineHeight: placement.lineHeight,
        handwritingFontSize: placement.fontSize,
        autoConverted: false,
      },
    }));
    return this.selection.replaceSelectedStrokesWithTexts(sourceStrokes, textObjects);
  }

  private commitRecognizedHandwriting(conversion: HandwritingRecognitionCommit): boolean {
    // Automatic H2T is intentionally one idle batch -> one fresh text object.
    // Do not inspect or merge with previously generated text: the source stroke
    // geometry is the only placement input for this commit.
    const placement = createBeautifiedTextPlacement(conversion.result.text, conversion.strokes, conversion.preferences);
    if (!placement) return false;
    const sourceLayerId = conversion.strokes[0]?.layerId;
    const textObject: TextObject = {
      id: generateId('txt'),
      type: 'text',
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      content: createHandwritingTipTapContent(conversion.result.text, {
        fontFamily: conversion.preferences.fontFamily,
        fontSize: placement.fontSize,
        color: conversion.preferences.color,
      }),
      createdAt: Date.now(),
      layerId: sourceLayerId ?? this.layers.getActiveLayerId(),
      metadata: {
        generatedFrom: 'handwriting-recognition',
        recognitionProvider: conversion.providerId,
        recognitionLanguage: conversion.result.language ?? (conversion.preferences.language || undefined),
        recognitionBatchId: conversion.batchId,
        handwritingLineId: conversion.batchId,
        sourcePageId: conversion.pageId ?? undefined,
        sourceStrokeIds: conversion.strokes.map(stroke => stroke.id),
        sourceBounds: conversion.sourceBounds,
        sourceBaseline: placement.baseline,
        sourceLineHeight: conversion.sourceBounds.height,
        sourceLeftX: conversion.sourceBounds.x,
        sourceRightX: conversion.sourceBounds.x + conversion.sourceBounds.width,
        handwritingLineHeight: placement.lineHeight,
        handwritingFontSize: placement.fontSize,
        autoConverted: true,
      },
    };
    this.history.pushReplacingCreations(createHandwritingConversionCommand({
      getStrokes: () => this.drawing.getStrokes(),
      setStrokes: strokes => this.drawing.setStrokes(strokes),
      addText: text => this.texts.addText(text),
      removeText: id => { this.texts.removeText(id); },
      // Real-time conversion must not steal a later selection while recognition
      // resolves asynchronously. Manual conversion retains its existing behavior.
      setSelection: () => {},
      redraw: () => this.drawing.redraw(),
    }, conversion.strokes, textObject, { updateSelection: false }), conversion.strokes.map(stroke => stroke.id));
    return true;
  }

  // ---- Page Properties ----

  getProperties(): Readonly<PageProperties> {
    return this.properties;
  }

  setProperties(updates: Partial<PageProperties>, source: PagePropertyChangeSource = 'user'): void {
    this.properties = { ...this.properties, ...updates };
    // A paper-color-only update changes the page shell, not the committed scene.
    // Keep the scene revision stable so a later page handoff does not recapture
    // thousands of unchanged ink points just to persist metadata.
    if (source !== 'appearance') this.drawingRevision += 1;
    const dimensions = resolvePageDimensions(this.properties);
    this.ruler.setMaxLength(Math.max(dimensions.width, dimensions.height));
    this.notifyPropertiesChange(source);
  }

  onPropertiesChange(listener: (props: Readonly<PageProperties>, source: PagePropertyChangeSource) => void): () => void {
    this.propertiesListeners.add(listener);
    return () => this.propertiesListeners.delete(listener);
  }

  private notifyPropertiesChange(source: PagePropertyChangeSource): void {
    this.propertiesListeners.forEach(listener => listener(this.properties, source));
  }

  // ---- Cleanup ----

  destroy(): void {
    this.input.flushPendingErasing('destroy');
    this.unsubscribeDrawingRevision?.();
    this.unsubscribeDrawingRevision = null;
    this.unsubscribeHistoryRevision?.();
    this.unsubscribeHistoryRevision = null;
    this.sceneMutations.clear();
    this.sceneMutationListeners.clear();
    this.unsubscribeHandwritingLifecycle?.();
    this.unsubscribeHandwritingLifecycle = null;
    this.unsubscribeHandwritingTool?.();
    this.unsubscribeHandwritingTool = null;
    this.handwriting.destroy();
    this.unmount();
    this.images.destroy();
    this.history.clear();
    this.tools.reset();
  }
}
