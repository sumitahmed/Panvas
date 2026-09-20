import type { LineStyle } from './lineStyleGeometry.ts';
// ============================================
// Panvas — Notebook Drawing Engine Types
// ============================================

/** A single point in a stroke, captured from a pointer event. */
export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  /** Timestamp in ms (relative to stroke start). Used for replay and velocity calculations. */
  t: number;
}

/** Object types that can exist on a Notebook Page. */
export type NotebookObjectType = 'stroke' | 'shape' | 'text' | 'image' | 'table' | 'code' | 'callout' | 'sticky' | 'divider' | 'attachment';

/** Base interface for all structured objects on a page. */
export interface BasePageObject {
  id: string;
  type: NotebookObjectType;
  /** X coordinate (left). Optional for strokes which compute it dynamically. */
  x?: number;
  /** Y coordinate (top). Optional for strokes which compute it dynamically. */
  y?: number;
  /** Width. Optional for strokes which compute it dynamically. */
  width?: number;
  /** Height. Optional for strokes which compute it dynamically. */
  height?: number;
  /** Timestamp when the object was created. */
  createdAt: number;
  /** General metadata for plugins/extensions. */
  metadata?: Record<string, any>;
  /** Stable owning layer. Missing legacy values migrate to the default layer. */
  layerId?: string;
}

export interface PageLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  order: number;
}

export interface AudioNote {
  id: string;
  fileId: string;
  fileName: string;
  /** User-facing name. The generated filename remains the compatibility fallback. */
  title?: string;
  mimeType: string;
  durationMs?: number;
  createdAt: number;
}

export const DEFAULT_PAGE_LAYER_ID = 'layer-default';

export function createDefaultPageLayer(): PageLayer {
  return { id: DEFAULT_PAGE_LAYER_ID, name: 'Content', visible: true, locked: false, order: 0 };
}

/** A freehand stroke drawn by pen, pencil, highlighter, or marker. */
export type InkFamily = 'ballpoint' | 'fountain' | 'brush' | 'felt';

export interface Stroke extends BasePageObject {
  type: 'stroke';
  tool: DrawingToolId;
  points: StrokePoint[];
  color: string;
  thickness: number;
  opacity: number;
  /** Vector path pattern. Missing legacy values render as solid. */
  pattern?: StrokePattern;
  inkFamily?: InkFamily;
  /** New faithful pen geometry. Absent on saved legacy strokes: retain their renderer. */
  centerline?: 'polyline';
  /** Retained vector area after erasing, relative to points[0]. Polygon rings may contain holes.
   * Keeps the original pressure path/caps intact; travels with the ink on move/copy. */
  inkClip?: [number, number][][][];
}

/** Shape types supported by the shape tool. */
export type ShapeType = 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'arrow' | 'line';

/** A vector shape placed on the drawing layer. */
export interface Shape extends BasePageObject {
  lineStyle?: LineStyle;
  type: 'shape';
  shapeType: ShapeType;
  /** Top-left corner in page coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
  fill: string | null;
  rotation: number;
  opacity?: number;
}

/** A floating text box. */
export interface TextObject extends BasePageObject {
  type: 'text';
  fontFamily?: string;
  x: number;
  y: number;
  width: number;
  content: any; // TipTap JSON
  rotation?: number;
}

/** An image rendered on the canvas. */
export interface ImageObject extends BasePageObject {
  /** Visible rectangle normalized against the unchanged original asset. */
  crop?: { x: number; y: number; width: number; height: number };
  type: 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  fileId: string;
  rotation: number;
  /** Independent visual opacity; omitted legacy images render fully opaque. */
  opacity?: number;
}

/** A union of all valid notebook objects. */
export type NotebookObject = Stroke | Shape | TextObject | ImageObject;

import {
  DEFAULT_PAGE_PROPERTY_SET,
  type PagePropertySet,
  type PageTemplateId,
} from '../../../types/notebook.ts';

/** Template backgrounds for notebook pages. */
export type PageTemplate = PageTemplateId;

/** Page properties that affect rendering and layout. */
export interface PageProperties extends PagePropertySet {}

/** Default page properties for new pages. */
export const DEFAULT_PAGE_PROPERTIES: PageProperties = { ...DEFAULT_PAGE_PROPERTY_SET };

/** The complete drawing data for a notebook page, persisted to {pageId}.drawing.json. */
export interface DrawingData {
  version: 1 | 2 | 3;
  /** @deprecated Used in version 1, migrated to objects in version 2. */
  strokes?: Stroke[];
  /** @deprecated Used in version 1, migrated to objects in version 2. */
  shapes?: Shape[];
  /** Unified structured content objects. (Version 2+) */
  objects?: NotebookObject[];
  /** Ordered user-visible layers. Introduced in version 3. */
  layers?: PageLayer[];
  activeLayerId?: string;
  audioNotes?: AudioNote[];
  properties: PageProperties;
}

/** Empty drawing data for new pages. */
export function createEmptyDrawingData(): DrawingData {
  return {
    version: 3,
    objects: [],
    layers: [createDefaultPageLayer()],
    activeLayerId: DEFAULT_PAGE_LAYER_ID,
    audioNotes: [],
    properties: { ...DEFAULT_PAGE_PROPERTIES },
  };
}

/** Empty drawing data initialized with specific user defaults. */
export function createDefaultDrawingData(settings?: Partial<PageProperties>): DrawingData {
  const data = createEmptyDrawingData();
  if (settings) {
    if (settings.paperColor) data.properties.paperColor = settings.paperColor;
    if (settings.template) data.properties.template = settings.template;
    if (settings.orientation) data.properties.orientation = settings.orientation.toLowerCase() as any;
    if (settings.pageSize) data.properties.pageSize = settings.pageSize;
    if (settings.margins) data.properties.margins = settings.margins;
    data.properties = { ...data.properties, ...settings };
    if (settings.orientation) {
      data.properties.orientation = settings.orientation.toLowerCase() as any;
    }
  }
  return data;
}

// ---- Tool State ----

/** Drawing tool identifiers. */
export type DrawingToolId = 'pen' | 'pencil' | 'highlighter' | 'marker' | 'eraser' | 'laser';
export type StrokePattern = 'solid' | 'dashed' | 'dotted';

/** Eraser modes. */
export type EraserMode = 'stroke' | 'pixel' | 'highlighter' | 'all';

/** Shape tool sub-modes. */
export type ShapeToolMode = ShapeType;

/** Notebook layout scroll direction mode (locked to vertical single-page) */
export type ScrollDirection = 'vertical';

/** The active mode of the notebook page. */
export type NotebookMode = 'text' | 'draw' | 'select' | 'erase' | 'shape' | 'hand';

/** Complete tool state managed by ToolManager. */
export interface ToolState {
  mode: NotebookMode;
  drawingTool: DrawingToolId;
  /** Independent recognition toggle layered over a compatible drawing tool. */
  handwritingToTextEnabled: boolean;
  /** Temporary raw-ink style used only while recognition is enabled. */
  handwritingInkColor: string;
  handwritingInkThickness: number;
  eraserMode: EraserMode;
  shapeTool: ShapeToolMode;
  color: string;
  thickness: number;
  opacity: number;
  pressureSensitivity: boolean;
  strokePattern: StrokePattern;
  inkFamily?: InkFamily;
  scribbleToErase: boolean;
  circleToSelect: boolean;
  straightLineRecognition: boolean;
  snapRecognizedLines: boolean;
  roughShapeRecognition: boolean;
  snapRecognizedShapes: boolean;
  rulerEnabled: boolean;
  stabilization: number; // 0-100
  shapeFillEnabled: boolean;
  lineStyle?: LineStyle;
}

/** Default tool state. */
export const DEFAULT_TOOL_STATE: ToolState = {
  mode: 'text',
  drawingTool: 'pen',
  handwritingToTextEnabled: false,
  handwritingInkColor: '#20242a',
  handwritingInkThickness: 2.4,
  eraserMode: 'pixel',
  shapeTool: 'rectangle',
  color: '#20242a',
  thickness: 2,
  opacity: 1,
  pressureSensitivity: true,
  strokePattern: 'solid',
  scribbleToErase: false,
  circleToSelect: false,
  straightLineRecognition: false,
  snapRecognizedLines: true,
  roughShapeRecognition: false,
  snapRecognizedShapes: false,
  rulerEnabled: false,
  stabilization: 50,
  shapeFillEnabled: false,
};

// ---- Unified History ----

/** A command in the unified undo/redo history. */
export interface HistoryCommand {
  /** Human-readable description for debugging. */
  description: string;
  /** IDs introduced by this command, used when a later atomic transform consumes them. */
  createdObjectIds?: readonly string[];
  /** Execute the command (or re-execute on redo). */
  execute: () => void;
  /** Reverse the command on undo. */
  undo: () => void;
}

// ---- Viewport ----

/** Viewport state for pan/zoom. */
export interface ViewportState {
  /** Horizontal offset in CSS pixels. */
  offsetX: number;
  /** Vertical offset in CSS pixels. */
  offsetY: number;
  /** Zoom level (1 = 100%). */
  scale: number;
}

export const DEFAULT_VIEWPORT_STATE: ViewportState = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
};

// ---- Selection ----

/** Axis-aligned bounding box. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A selected element (stroke, shape, or text). */
export interface SelectedElement {
  type: 'stroke' | 'shape' | 'text' | 'image';
  id: string;
}
