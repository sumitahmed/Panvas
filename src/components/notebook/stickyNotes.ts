import type { TextObject } from './engine/drawingTypes.ts';
import type { NotebookEngine } from './engine/NotebookEngine.ts';

export const STICKY_NOTE_WIDTH = 220;
export const STICKY_NOTE_MIN_HEIGHT = 180;
// Three 12px resize handles fit along a 32px edge without overlapping.
// Creation presets keep their existing dimensions; this is only a resize floor.
export const STICKY_NOTE_RESIZE_MIN = 32;
export const DEFAULT_STICKY_NOTE_COLOR = '#fef08a';

export const STICKY_NOTE_COLORS = [
  { name: 'Yellow', value: '#fef08a' },
  { name: 'Pink', value: '#fbcfe8' },
  { name: 'Blue', value: '#bae6fd' },
  { name: 'Green', value: '#bbf7d0' },
  { name: 'Peach', value: '#fed7aa' },
  { name: 'Warm Yellow', value: '#fef08a' },
  { name: 'Soft Green', value: '#bbf7d0' },
  { name: 'Sky Blue', value: '#bae6fd' },
  { name: 'Rose Pink', value: '#fbcfe8' },
  { name: 'Lavender', value: '#e9d5ff' },
  { name: 'Warm Peach', value: '#fed7aa' },
  { name: 'Neutral Gray', value: '#e5e7eb' },
] as const;

export const STICKY_NOTE_SHAPES = [
  { id: 'rounded-rect', label: 'Rounded' },
  { id: 'square', label: 'Square' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'circle', label: 'Circle' },
  { id: 'oval', label: 'Oval' },
  { id: 'star', label: 'Star' },
] as const;

export type StickyNoteShape = (typeof STICKY_NOTE_SHAPES)[number]['id'];
export const DEFAULT_STICKY_NOTE_SHAPE: StickyNoteShape = 'rounded-rect';

/** Fit an equal-sided shape inside the current note instead of enlarging it. */
export function stickyShapeBounds(bounds: { width: number; height: number }, shape: StickyNoteShape) {
  if (shape === 'square' || shape === 'circle') {
    const edge = Math.max(STICKY_NOTE_RESIZE_MIN, Math.min(bounds.width, bounds.height));
    return { width: edge, height: edge };
  }
  return bounds;
}

export type StickyPaper = 'plain' | 'lined' | 'grid';
export const STICKY_PRESETS = [
  { id: 'classic', label: 'Classic', shape: 'square', color: '#fef08a', opacity: 1, paper: 'plain', width: 200, height: 200 },
  { id: 'memo', label: 'Memo', shape: 'rounded-rect', color: '#fbcfe8', opacity: 1, paper: 'plain', width: 240, height: 160 },
  { id: 'translucent', label: 'Translucent', shape: 'square', color: '#bae6fd', opacity: 0.5, paper: 'plain', width: 200, height: 200 },
  { id: 'lined', label: 'Lined memo', shape: 'rectangle', color: '#fef08a', opacity: 1, paper: 'lined', width: 240, height: 180 },
  { id: 'grid', label: 'Grid memo', shape: 'square', color: '#bbf7d0', opacity: 1, paper: 'grid', width: 200, height: 200 },
  { id: 'label', label: 'Label', shape: 'rounded-rect', color: '#e9d5ff', opacity: 1, paper: 'plain', width: 240, height: 100 },
  { id: 'card', label: 'Paper card', shape: 'rectangle', color: '#fffdf5', opacity: 1, paper: 'lined', width: 280, height: 180 },
] as const;
export function getStickyPaper(object: Pick<TextObject, 'metadata'>): StickyPaper {
  return object.metadata?.paper === 'lined' || object.metadata?.paper === 'grid' ? object.metadata.paper : 'plain';
}
export function stickyPaperStyle(object: Pick<TextObject, 'metadata'>, spacing = 24) {
  const paper = getStickyPaper(object);
  const ink = `rgba(40,45,50,${0.14 * getStickyNoteOpacity(object)})`;
  return { backgroundImage: paper === 'lined' ? `linear-gradient(to bottom, transparent ${spacing - 1}px, ${ink} 1px)` : paper === 'grid' ? `linear-gradient(to bottom, ${ink} 1px, transparent 1px), linear-gradient(to right, ${ink} 1px, transparent 1px)` : undefined, backgroundSize: `${spacing}px ${spacing}px` };
}
export function createStickyPreset(id: string, objectId: string, x: number, y: number): TextObject {
  const preset = STICKY_PRESETS.find(item => item.id === id) ?? STICKY_PRESETS[0];
  const note = createStickyNote({ ...preset, id: objectId, x, y });
  return { ...note, width: preset.width, height: preset.height, metadata: { ...note.metadata, paper: preset.paper } };
}

/** Insert a gallery preset through the same validated, history-aware path as Local Elements. */
export function insertStickyPreset(engine: NotebookEngine, id: string): TextObject | null {
  const preset = STICKY_PRESETS.find(item => item.id === id);
  if (!preset) return null;
  const source = createStickyPreset(preset.id, `sticky-preset-${preset.id}`, 0, 0);
  const inserted = engine.selection.pasteElements({
    type: 'panvas/elements', strokes: [], shapes: [], texts: [source], images: [],
  }, engine.drawing.getInsertionPoint(preset.width, preset.height), () => engine.input.notifyChange());
  if (!inserted) return null;
  // Match Local Elements: finish the history transaction before changing the
  // toolbar's active group, so a portal-hosted gallery cannot unmount mid-click.
  engine.tools.setMode('select');
  const selection = engine.selection.getSelectedElements();
  const selected = selection.length === 1 && selection[0].type === 'text'
    ? engine.texts.getTexts().find(text => text.id === selection[0].id)
    : undefined;
  return selected ?? null;
}

export function isValidHexColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim());
}

export const isStickyNoteColor = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return STICKY_NOTE_COLORS.some(color => color.value.toLowerCase() === normalized) || isValidHexColor(value);
};

export const isStickyNote = (object: Pick<TextObject, 'metadata'>): boolean =>
  object.metadata?.isStickyNote === true;

/** Older starter stickies stored their prompt as document content instead of a placeholder. */
export function isLegacyStickyPlaceholderContent(content: unknown): boolean {
  const text = (content as { content?: Array<{ content?: Array<{ text?: unknown }> }> })?.content
    ?.flatMap(paragraph => paragraph.content ?? [])
    .map(node => typeof node.text === 'string' ? node.text : '')
    .join('')
    .trim();
  return text === 'Add a thought...' || text === 'Add a thought…' || text === 'Take a note...';
}

export function getStickyNoteColor(object: Pick<TextObject, 'metadata'>): string {
  return isStickyNoteColor(object.metadata?.color)
    ? (object.metadata!.color as string)
    : DEFAULT_STICKY_NOTE_COLOR;
}

export function getStickyNoteOpacity(object: Pick<TextObject, 'metadata'>): number {
  const opacity = object.metadata?.opacity;
  if (typeof opacity === 'number' && Number.isFinite(opacity)) {
    return Math.max(0, Math.min(1, opacity));
  }
  return 1;
}

export function getStickyNoteShape(object: Pick<TextObject, 'metadata'>): StickyNoteShape {
  const shape = object.metadata?.shape;
  if (
    shape === 'square' ||
    shape === 'rounded-rect' ||
    shape === 'rectangle' ||
    shape === 'circle' ||
    shape === 'oval' ||
    shape === 'star'
  ) {
    return shape;
  }
  return DEFAULT_STICKY_NOTE_SHAPE;
}

export function getShapeBorderRadius(shape: StickyNoteShape): string {
  switch (shape) {
    case 'square':
    case 'rectangle':
      return '0px';
    case 'circle':
      return '9999px';
    case 'oval':
      return '50%';
    case 'rounded-rect':
    default:
      return '12px';
  }
}

export function hexToRgba(hex: string, opacity: number): string {
  const cleanHex = hex.replace('#', '').trim();
  let r = 254;
  let g = 240;
  let b = 138;
  if (cleanHex.length === 3) {
    r = parseInt(cleanHex[0] + cleanHex[0], 16);
    g = parseInt(cleanHex[1] + cleanHex[1], 16);
    b = parseInt(cleanHex[2] + cleanHex[2], 16);
  } else if (cleanHex.length >= 6) {
    r = parseInt(cleanHex.slice(0, 2), 16);
    g = parseInt(cleanHex.slice(2, 4), 16);
    b = parseInt(cleanHex.slice(4, 6), 16);
  }
  const safeAlpha = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
}

export function createStickyNote({
  id,
  x,
  y,
  color = DEFAULT_STICKY_NOTE_COLOR,
  opacity = 1,
  shape = DEFAULT_STICKY_NOTE_SHAPE,
  createdAt = Date.now(),
}: {
  id: string;
  x: number;
  y: number;
  color?: string;
  opacity?: number;
  shape?: StickyNoteShape;
  createdAt?: number;
}): TextObject {
  let width = STICKY_NOTE_WIDTH;
  let height = STICKY_NOTE_MIN_HEIGHT;
  if (shape === 'square' || shape === 'circle') {
    width = 200;
    height = 200;
  } else if (shape === 'rectangle') {
    width = 240;
    height = 160;
  } else if (shape === 'star') {
    width = 220;
    height = 220;
  }

  return {
    id,
    type: 'text',
    x,
    y,
    width,
    height,
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    },
    createdAt,
    metadata: {
      isStickyNote: true,
      color: isStickyNoteColor(color) ? color : DEFAULT_STICKY_NOTE_COLOR,
      opacity: Math.max(0, Math.min(1, opacity)),
      shape,
    },
  };
}

export function updateStickyNote(
  object: TextObject,
  updates: { color?: string; opacity?: number; shape?: StickyNoteShape }
): TextObject {
  const nextColor =
    updates.color !== undefined
      ? isStickyNoteColor(updates.color)
        ? updates.color
        : getStickyNoteColor(object)
      : getStickyNoteColor(object);
  const nextOpacity =
    updates.opacity !== undefined
      ? Math.max(0, Math.min(1, updates.opacity))
      : getStickyNoteOpacity(object);
  const nextShape = updates.shape !== undefined ? updates.shape : getStickyNoteShape(object);

  return {
    ...object,
    metadata: {
      ...(object.metadata ?? {}),
      isStickyNote: true,
      color: nextColor,
      opacity: nextOpacity,
      shape: nextShape,
    },
  };
}

export function updateStickyNoteColor(object: TextObject, color: string): TextObject {
  return updateStickyNote(object, { color });
}
