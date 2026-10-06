import assert from 'node:assert/strict';
import test from 'node:test';
import type { DrawingData, TextObject } from '../src/components/notebook/engine/drawingTypes.ts';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager.ts';
import { LayerManager } from '../src/components/notebook/engine/LayerManager.ts';
import { TextManager } from '../src/components/notebook/engine/TextManager.ts';
import { SelectionEngine } from '../src/components/notebook/engine/SelectionEngine.ts';
import {
  createStickyNote,
  DEFAULT_STICKY_NOTE_COLOR,
  DEFAULT_STICKY_NOTE_SHAPE,
  getShapeBorderRadius,
  getStickyNoteColor,
  getStickyNoteOpacity,
  getStickyNoteShape,
  hexToRgba,
  isStickyNote,
  isStickyNoteColor,
  isValidHexColor,
  STICKY_NOTE_COLORS,
  STICKY_NOTE_MIN_HEIGHT,
  STICKY_NOTE_SHAPES,
  STICKY_NOTE_WIDTH,
  STICKY_NOTE_RESIZE_MIN,
  stickyShapeBounds,
  updateStickyNote,
  updateStickyNoteColor,
  type StickyNoteShape,
} from '../src/components/notebook/stickyNotes.ts';

test('small and narrow sticky shapes fit inside existing bounds without inflation', () => {
  for (const bounds of [{ width: 32, height: 32 }, { width: 240, height: 40 }, { width: 40, height: 240 }]) {
    for (const shape of STICKY_NOTE_SHAPES) {
      const next = stickyShapeBounds(bounds, shape.id);
      assert.ok(next.width >= STICKY_NOTE_RESIZE_MIN && next.height >= STICKY_NOTE_RESIZE_MIN);
      assert.ok(next.width <= bounds.width && next.height <= bounds.height);
      if (shape.id === 'square' || shape.id === 'circle') assert.equal(next.width, next.height);
      else assert.deepEqual(next, bounds);
    }
  }
});

test('single sticky uses DOM chrome while mixed selection keeps generic controls and logical ownership', () => {
  const layers = new LayerManager(), texts = new TextManager(layers);
  const note = createStickyNote({ id: 'single-sticky', x: 100, y: 100 });
  texts.addText(note);
  const image = { id: 'image', type: 'image', x: 400, y: 400, width: 80, height: 60 };
  const history = new HistoryManager();
  const selection = new SelectionEngine({ redraw() {}, getStrokes: () => [] } as any,
    { getShapes: () => [], removeShapes: () => [] } as any, history,
    { getState: () => ({ scale: 1 }), applyTransform() {} } as any,
    texts, { getImages: () => [image], removeImages: () => [] } as any, layers);
  let boxes = 0;
  const ctx = new Proxy({ strokeRect: () => { boxes++; } }, { get: (target, key) => target[key as keyof typeof target] ?? (() => {}) }) as any;
  selection.select(note.id, 'text');
  selection.renderSelection(ctx);
  assert.equal(boxes, 0);
  assert.deepEqual(selection.getSelectedElements(), [{ id: note.id, type: 'text' }]);
  assert.equal(selection.getHandleAt(96, 96), null);
  selection.select(image.id, 'image', true);
  selection.renderSelection(ctx);
  assert.equal(boxes, 18);
  assert.equal(selection.getHandleAt(96, 96)?.id, note.id);
  selection.clearSelection();
  assert.equal(selection.getSelectedElements().length, 0);
  selection.select(note.id, 'text');
  // Empty stroke/shape collections use the same mixed deletion transaction.
  (selection as any).drawingEngine.removeStrokes = () => [];
  selection.deleteSelection();
  assert.equal(texts.getTexts().length, 0);
  history.undo();
  assert.equal(texts.getTexts()[0], note);
  assert.equal(selection.getSelectedElements()[0].id, note.id);
  history.redo();
  assert.equal(texts.getTexts().length, 0);
});

test('creates sticky note with all 6 supported shapes and appropriate default bounds', () => {
  const shapes: StickyNoteShape[] = ['square', 'rounded-rect', 'rectangle', 'circle', 'oval', 'star'];

  for (const shape of shapes) {
    const note = createStickyNote({ id: `note-${shape}`, x: 50, y: 50, shape });
    assert.equal(note.type, 'text');
    assert.equal(isStickyNote(note), true);
    assert.equal(getStickyNoteShape(note), shape);

    if (shape === 'square' || shape === 'circle') {
      assert.equal(note.width, 200);
      assert.equal(note.height, 200);
    } else if (shape === 'rectangle') {
      assert.equal(note.width, 240);
      assert.equal(note.height, 160);
    } else if (shape === 'star') {
      assert.equal(note.width, 220);
      assert.equal(note.height, 220);
    } else {
      assert.equal(note.width, STICKY_NOTE_WIDTH);
      assert.equal(note.height, STICKY_NOTE_MIN_HEIGHT);
    }
  }
});

test('validates hex color and sticky note presets', () => {
  assert.equal(isValidHexColor('#fff'), true);
  assert.equal(isValidHexColor('#ffffff'), true);
  assert.equal(isValidHexColor('#fef08a'), true);
  assert.equal(isValidHexColor('#12345678'), true);
  assert.equal(isValidHexColor('rgb(0,0,0)'), false);
  assert.equal(isValidHexColor('invalid'), false);

  for (const preset of STICKY_NOTE_COLORS) {
    assert.equal(isStickyNoteColor(preset.value), true);
  }
  assert.equal(isStickyNoteColor('#3b82f6'), true);
});

test('updates sticky note color (preset and custom hex) and opacity (10-100%)', () => {
  let note = createStickyNote({ id: 'sticky-color-opacity', x: 0, y: 0 });
  assert.equal(getStickyNoteColor(note), DEFAULT_STICKY_NOTE_COLOR);
  assert.equal(getStickyNoteOpacity(note), 1);

  // Update preset color
  note = updateStickyNote(note, { color: '#fbcfe8' });
  assert.equal(getStickyNoteColor(note), '#fbcfe8');

  // Update custom hex color
  note = updateStickyNote(note, { color: '#3b82f6' });
  assert.equal(getStickyNoteColor(note), '#3b82f6');

  // Update opacity clamped within 0 to 1
  note = updateStickyNote(note, { opacity: 0.5 });
  assert.equal(getStickyNoteOpacity(note), 0.5);

  note = updateStickyNote(note, { opacity: 1.5 });
  assert.equal(getStickyNoteOpacity(note), 1);

  note = updateStickyNote(note, { opacity: -0.2 });
  assert.equal(getStickyNoteOpacity(note), 0);

  // Test hexToRgba conversion
  const rgba = hexToRgba('#3b82f6', 0.8);
  assert.match(rgba, /^rgba\(\d+,\s*\d+,\s*\d+,\s*0\.8\)$/);
});

test('shape border radius calculation matches specification', () => {
  assert.equal(getShapeBorderRadius('square'), '0px');
  assert.equal(getShapeBorderRadius('rectangle'), '0px');
  assert.equal(getShapeBorderRadius('circle'), '9999px');
  assert.equal(getShapeBorderRadius('oval'), '50%');
  assert.equal(getShapeBorderRadius('rounded-rect'), '12px');
});

test('TextManager tracks position, bounds, metadata updates, and focused text', () => {
  const layerManager = new LayerManager();
  const textManager = new TextManager(layerManager);

  const note = createStickyNote({ id: 'sticky-mgr-1', x: 100, y: 150 });
  textManager.addText(note);

  assert.equal(textManager.getTexts().length, 1);
  assert.equal(textManager.getTexts()[0].id, 'sticky-mgr-1');
  assert.equal(textManager.getTexts()[0].layerId, layerManager.getActiveLayerId());

  // Update position and bounds (simulating drag / resize)
  textManager.updateTextPositionAndBounds('sticky-mgr-1', 120, 180, 260, 220);
  const updated = textManager.getTexts()[0];
  assert.equal(updated.x, 120);
  assert.equal(updated.y, 180);
  assert.equal(updated.width, 260);
  assert.equal(updated.height, 220);

  // Update metadata
  textManager.updateTextMetadata('sticky-mgr-1', { color: '#bbf7d0', shape: 'circle' });
  const metaUpdated = textManager.getTexts()[0];
  assert.equal(metaUpdated.metadata?.color, '#bbf7d0');
  assert.equal(metaUpdated.metadata?.shape, 'circle');

  // Active/focused tracking
  textManager.setActiveTextId('sticky-mgr-1');
  assert.equal(textManager.getActiveTextId(), 'sticky-mgr-1');
  assert.equal(textManager.getFocusedText()?.id, 'sticky-mgr-1');
});

test('undo and redo properly restore sticky note position, bounds, and styling', () => {
  const history = new HistoryManager();
  const layerManager = new LayerManager();
  const textManager = new TextManager(layerManager);

  const initialNote = createStickyNote({ id: 'sticky-undo-1', x: 50, y: 50 });
  textManager.addText(initialNote);

  // 1. Move action
  // 1. Move action - use push() so it calls execute() to apply immediately
  const moveStartX = 50;
  const moveStartY = 50;
  const moveEndX = 150;
  const moveEndY = 200;

  history.push({
    description: 'Move sticky note',
    execute: () => {
      textManager.updateTextPositionAndBounds('sticky-undo-1', moveEndX, moveEndY, initialNote.width, initialNote.height);
    },
    undo: () => {
      textManager.updateTextPositionAndBounds('sticky-undo-1', moveStartX, moveStartY, initialNote.width, initialNote.height);
    },
  });

  assert.equal(textManager.getTexts()[0].x, moveEndX);
  assert.equal(textManager.getTexts()[0].y, moveEndY);

  // Undo move
  history.undo();
  assert.equal(textManager.getTexts()[0].x, moveStartX);
  assert.equal(textManager.getTexts()[0].y, moveStartY);

  // Redo move
  history.redo();
  assert.equal(textManager.getTexts()[0].x, moveEndX);
  assert.equal(textManager.getTexts()[0].y, moveEndY);

  // 2. Styling update action
  // 2. Styling update action - use push() so it calls execute() to apply immediately
  const prevColor = getStickyNoteColor(textManager.getTexts()[0]);
  const newColor = '#bae6fd';

  history.push({
    description: 'Update sticky note styling',
    execute: () => {
      textManager.updateTextMetadata('sticky-undo-1', { color: newColor });
    },
    undo: () => {
      textManager.updateTextMetadata('sticky-undo-1', { color: prevColor });
    },
  });

  assert.equal(getStickyNoteColor(textManager.getTexts()[0]), newColor);

  history.undo();
  assert.equal(getStickyNoteColor(textManager.getTexts()[0]), prevColor);

  history.redo();
  assert.equal(getStickyNoteColor(textManager.getTexts()[0]), newColor);
});

test('DrawingData v3 full roundtrip preserves sticky note custom attributes', () => {
  const note = createStickyNote({
    id: 'roundtrip-note',
    x: 75,
    y: 125,
    color: '#fed7aa',
    opacity: 0.85,
    shape: 'oval',
  });

  const drawingData: DrawingData = {
    version: 3,
    objects: [note],
    strokes: [],
    shapes: [],
    texts: [note],
    images: [],
    layers: [
      { id: 'layer-default', name: 'Base Layer', visible: true, locked: false, order: 0 },
    ],
    activeLayerId: 'layer-default',
  };

  const serialized = JSON.stringify(drawingData);
  const deserialized = JSON.parse(serialized) as DrawingData;

  assert.equal(deserialized.version, 3);
  const recovered = deserialized.texts.find(t => t.id === 'roundtrip-note')!;
  assert.ok(recovered);
  assert.equal(recovered.x, 75);
  assert.equal(recovered.y, 125);
  assert.equal(isStickyNote(recovered), true);
  assert.equal(getStickyNoteColor(recovered), '#fed7aa');
  assert.equal(getStickyNoteOpacity(recovered), 0.85);
  assert.equal(getStickyNoteShape(recovered), 'oval');
});
