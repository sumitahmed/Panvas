import assert from 'node:assert/strict';
import test from 'node:test';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import { FontSize } from '../src/components/notebook/FontSizeExtension.ts';
import {
  captureFormattingSelection,
  resolveFormattingEditor,
  runFormattingCommand,
} from '../src/components/notebook/textFormatting.ts';
import {
  getPencilRenderPoint,
  getStrokeRenderHalfWidth,
  splitStrokePointsOutsideCircle,
} from '../src/components/notebook/engine/strokeGeometry.ts';
import { EraserEngine } from '../src/components/notebook/engine/EraserEngine.ts';
import { strokeRegion, regionIntersects, eraserCapsule, exposedEraser } from '../src/components/notebook/engine/inkRegion.ts';
import { analyzeScribble, findScribbleTargets } from '../src/components/notebook/engine/scribbleGesture.ts';
import { analyzeCircleGesture, isPointInsideLoop } from '../src/components/notebook/engine/circleSelectGesture.ts';
import { recognizeStraightLine } from '../src/components/notebook/engine/straightLineGesture.ts';
import { recognizeRoughShape } from '../src/components/notebook/engine/roughShapeGesture.ts';
import { ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';
import { InputManager } from '../src/components/notebook/engine/InputManager.ts';
import { SelectionEngine } from '../src/components/notebook/engine/SelectionEngine.ts';
import { LayerManager } from '../src/components/notebook/engine/LayerManager.ts';
import { RulerManager } from '../src/components/notebook/engine/RulerManager.ts';
import { LaserManager } from '../src/components/notebook/engine/LaserManager.ts';
import { ToolManager } from '../src/components/notebook/engine/ToolManager.ts';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager.ts';
import { DEFAULT_TOOL_STATE, createEmptyDrawingData } from '../src/components/notebook/engine/drawingTypes.ts';
import type { ImageObject, Shape, Stroke, StrokePoint } from '../src/components/notebook/engine/drawingTypes.ts';

function createEditor(text = 'hello world'): Editor {
  const editor = new Editor({
    element: null,
    extensions: [
      StarterKit.configure({ underline: false }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
    ],
    content: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text }],
      }],
    },
  });

  // A headless TipTap editor has no EditorView and therefore reports isDestroyed=true even
  // though its ProseMirror state and command chain are fully usable. The production helper
  // correctly rejects destroyed mounted editors; expose the headless state object as usable
  // for command-level tests only.
  Object.defineProperty(editor, 'isDestroyed', { configurable: true, get: () => false });
  return editor;
}

function disposeEditor(editor: Editor): void {
  delete (editor as any).isDestroyed;
  editor.destroy();
}

function selectedTextNode(editor: Editor): any {
  const paragraph = editor.getJSON().content?.[0];
  return paragraph?.content?.find(node => node.text === 'hello');
}

function mark(editor: Editor, type: string): any | undefined {
  return selectedTextNode(editor)?.marks?.find((candidate: any) => candidate.type === type);
}

function marksExceptBold(editor: Editor): any[] {
  return (selectedTextNode(editor)?.marks || []).filter((candidate: any) => candidate.type !== 'bold');
}

test('bold changes only the bold mark and preserves all other text formatting', () => {
  const editor = createEditor();
  editor.commands.setTextSelection({ from: 1, to: 6 });
  editor.chain()
    .setColor('#cc0000')
    .setHighlight({ color: '#ffee00' })
    .setFontFamily("'Courier New', monospace")
    .setFontSize('20px')
    .toggleItalic()
    .toggleUnderline()
    .toggleStrike()
    .setTextAlign('center')
    .run();

  const preservedMarks = JSON.parse(JSON.stringify(marksExceptBold(editor)));
  const preservedAlignment = editor.getJSON().content?.[0]?.attrs?.textAlign;

  for (const expectedBold of [true, false, true]) {
    runFormattingCommand(editor, captureFormattingSelection(editor), chain => chain.toggleBold());
    assert.equal(Boolean(mark(editor, 'bold')), expectedBold);
    assert.deepEqual(JSON.parse(JSON.stringify(marksExceptBold(editor))), preservedMarks);
    assert.equal(mark(editor, 'textStyle')?.attrs?.color, '#cc0000');
    assert.equal(mark(editor, 'highlight')?.attrs?.color, '#ffee00');
    assert.equal(editor.getJSON().content?.[0]?.attrs?.textAlign, preservedAlignment);
  }

  const blackEditor = createEditor();
  blackEditor.commands.setTextSelection({ from: 1, to: 6 });
  const blackMarks = JSON.parse(JSON.stringify(marksExceptBold(blackEditor)));
  runFormattingCommand(blackEditor, captureFormattingSelection(blackEditor), chain => chain.toggleBold());
  assert.deepEqual(JSON.parse(JSON.stringify(marksExceptBold(blackEditor))), blackMarks);
  assert.equal(mark(blackEditor, 'textStyle')?.attrs?.color, undefined);

  disposeEditor(editor);
  disposeEditor(blackEditor);
});

test('inline formatting repeatedly targets and preserves the same selected range', () => {
  const editor = createEditor();
  editor.commands.setTextSelection({ from: 1, to: 6 });
  let selection = captureFormattingSelection(editor);

  const toggles: Array<[string, (chain: any) => any]> = [
    ['bold', chain => chain.toggleBold()],
    ['italic', chain => chain.toggleItalic()],
    ['underline', chain => chain.toggleUnderline()],
    ['strike', chain => chain.toggleStrike()],
  ];

  for (const [type, command] of toggles) {
    selection = runFormattingCommand(editor, selection, command)!;
    assert.ok(mark(editor, type), `${type} should apply`);
    assert.deepEqual(selection, { from: 1, to: 6 });

    selection = runFormattingCommand(editor, selection, command)!;
    assert.equal(mark(editor, type), undefined, `${type} should toggle off`);
    assert.deepEqual(selection, { from: 1, to: 6 });

    selection = runFormattingCommand(editor, selection, command)!;
    assert.ok(mark(editor, type), `${type} should apply again without reselecting`);
  }

  disposeEditor(editor);
});

test('color, highlight, alignment and headings change only their own formatting domain', () => {
  const editor = createEditor();
  editor.commands.setTextSelection({ from: 1, to: 6 });
  let selection = captureFormattingSelection(editor);

  selection = runFormattingCommand(editor, selection, chain => chain.toggleBold())!;
  selection = runFormattingCommand(editor, selection, chain => chain.setColor('#cc0000'))!;
  assert.ok(mark(editor, 'bold'));
  assert.equal(mark(editor, 'textStyle')?.attrs?.color, '#cc0000');
  assert.equal(mark(editor, 'highlight'), undefined);

  selection = runFormattingCommand(editor, selection, chain => chain.setHighlight({ color: '#ffee00' }))!;
  assert.ok(mark(editor, 'bold'));
  assert.equal(mark(editor, 'textStyle')?.attrs?.color, '#cc0000');
  assert.equal(mark(editor, 'highlight')?.attrs?.color, '#ffee00');

  selection = runFormattingCommand(editor, selection, chain => chain.setTextAlign('center'))!;
  assert.equal(editor.getJSON().content?.[0]?.attrs?.textAlign, 'center');
  assert.ok(mark(editor, 'bold'));

  selection = runFormattingCommand(editor, selection, chain => chain.toggleHeading({ level: 2 }))!;
  assert.equal(editor.getJSON().content?.[0]?.type, 'heading');
  assert.equal(editor.getJSON().content?.[0]?.attrs?.level, 2);
  assert.ok(mark(editor, 'bold'));
  assert.deepEqual(selection, { from: 1, to: 6 });

  disposeEditor(editor);
});

test('font and block commands execute against a retained selection', () => {
  const cases: Array<[string, (chain: any) => any]> = [
    ['font family', chain => chain.setFontFamily("'Courier New', monospace")],
    ['font size', chain => chain.setFontSize('20px')],
    ['bullet list', chain => chain.toggleBulletList()],
    ['ordered list', chain => chain.toggleOrderedList()],
    ['task list', chain => chain.toggleTaskList()],
    ['blockquote', chain => chain.toggleBlockquote()],
    ['code block', chain => chain.toggleCodeBlock()],
  ];

  for (const [name, command] of cases) {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const before = JSON.stringify(editor.getJSON());
    const selection = runFormattingCommand(editor, captureFormattingSelection(editor), command);
    assert.notEqual(JSON.stringify(editor.getJSON()), before, `${name} should change the document`);
    assert.ok(selection, `${name} should retain a valid selection`);
    disposeEditor(editor);
  }
});

test('formatting editor resolution never falls back to an unrelated historical selection', () => {
  const first = createEditor('first');
  const second = createEditor('second');
  first.commands.setTextSelection({ from: 1, to: 3 });
  second.commands.setTextSelection({ from: 1, to: 4 });

  let selectedId: string | null = 'second';
  const engine = {
    selection: {
      getSelectedElements: () => selectedId ? [{ id: selectedId, type: 'text' }] : [],
    },
    texts: {
      getEditor: (id: string) => id === 'first' ? first : id === 'second' ? second : undefined,
    },
  } as any;

  assert.equal(resolveFormattingEditor(first as any, engine), first);
  assert.equal(resolveFormattingEditor(null, engine), second);

  selectedId = null;
  assert.equal(resolveFormattingEditor(null, engine), null);

  disposeEditor(first);
  disposeEditor(second);
});

test('canvas CSS coordinates convert to base PDF coordinates exactly once', () => {
  const viewport = new ViewportManager();
  viewport.setZoom(1.625);

  viewport.setRenderTransform({ scale: true });
  assert.deepEqual(viewport.canvasToPage(650, 325), { x: 400, y: 200 });

  viewport.setRenderTransform({ scale: false });
  assert.deepEqual(viewport.canvasToPage(650, 325), { x: 650, y: 325 });
});

test('notebook stroke coordinates remain logical and identical across backing zoom levels', () => {
  const viewport = new ViewportManager();
  const logicalPoint = { x: 137.5, y: 289.25 };
  viewport.setZoom(1);
  const at100 = viewport.canvasToPage(logicalPoint.x, logicalPoint.y);
  viewport.setZoom(4);
  const at400 = viewport.canvasToPage(logicalPoint.x, logicalPoint.y);
  assert.deepEqual(at400, at100);
  assert.deepEqual(at400, logicalPoint);
});

function point(x: number, y = 20): StrokePoint {
  return { x, y, pressure: 0.5, t: x * 3 };
}

test('marker and highlighter hit widths match their actual rendered widths', () => {
  const marker: Stroke = {
    id: 'marker', type: 'stroke', tool: 'marker', points: [point(0), point(10)],
    color: '#000', thickness: 10, opacity: 1, createdAt: 0,
  };
  const highlighter: Stroke = {
    ...marker, id: 'highlighter', tool: 'highlighter', thickness: 4,
  };

  assert.equal(getStrokeRenderHalfWidth(marker), 15);
  assert.equal(getStrokeRenderHalfWidth(highlighter), 12);
});

test('partial erase preserves every surviving pencil source point and its grain', () => {
  const points = Array.from({ length: 11 }, (_, index) => point(index * 10));
  const original = structuredClone(points);
  const segments = splitStrokePointsOutsideCircle(points, 50, 20, 10);

  assert.equal(segments.length, 2);
  assert.deepEqual(points, original, 'the source point array must not be mutated');
  assert.deepEqual(segments[0].map(candidate => candidate.x), [0, 10, 20, 30, 40]);
  assert.deepEqual(segments[1].map(candidate => candidate.x), [60, 70, 80, 90, 100]);

  const survivingOriginal = points[8];
  const survivingSplit = segments[1].find(candidate => candidate.x === survivingOriginal.x)!;
  assert.deepEqual(getPencilRenderPoint(survivingSplit, 0), getPencilRenderPoint(survivingOriginal, 0));
  assert.deepEqual(getPencilRenderPoint(survivingSplit, 1), getPencilRenderPoint(survivingOriginal, 1));
});

test('sparse stroke segments are cut at exact circle intersections without resampling', () => {
  const points = [point(0), point(100)];
  const segments = splitStrokePointsOutsideCircle(points, 50, 20, 10);

  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].map(candidate => candidate.x), [0, 40]);
  assert.deepEqual(segments[1].map(candidate => candidate.x), [60, 100]);
  assert.equal(segments[0][1].pressure, 0.5);
  assert.equal(segments[0][1].t, 120);
});

test('pixel eraser removes exposed ink while preserving only the interval covered by a ruler', () => {
  const points: StrokePoint[] = [
    { x: 0, y: 0, pressure: 0.5, t: 0 },
    { x: 100, y: 0, pressure: 0.5, t: 100 },
  ];
  const segments = splitStrokePointsOutsideCircle(points, 50, 0, 30, () => [0.45, 0.55]);
  assert.deepEqual(segments.map(segment => segment.map(point => Math.round(point.x))), [
    [0, 20],
    [45, 55],
    [80, 100],
  ]);
});

test('pixel eraser integration keeps ruler-covered ink without leaving an exterior dead zone', () => {
  const original: Stroke = {
    id: 'crossing-ruler', type: 'stroke', tool: 'pen', points: [point(0, 0), point(100, 0)],
    color: '#d00', thickness: 2, opacity: 1, createdAt: 0,
  };
  const drawing = new FakeDrawingEngine([original]);
  const eraser = new EraserEngine(drawing as any, { pushExecuted: () => {} } as any);
  const ruler = new RulerManager();
  ruler.setEnabled(true);
  ruler.setCenter(50, 0);
  ruler.setAngle(Math.PI / 2, false);
  eraser.setRulerManager(ruler);
  eraser.startErasing('pixel');
  eraser.eraseAt(50, 0, 'pixel', 100, false);
  assert.deepEqual(drawing.strokes[0].points, original.points);
  for (const x of [19, 50, 81]) assert.ok(regionIntersects(strokeRegion(drawing.strokes[0]), eraserCapsule({x,y:0},{x,y:0},.1)));
  for (const x of [0, 17, 83, 100]) assert.equal(regionIntersects(strokeRegion(drawing.strokes[0]), eraserCapsule({x,y:0},{x,y:0},.1)), false);
});

function distanceToSegmentSquared(
  x: number,
  y: number,
  start: StrokePoint,
  end: StrokePoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0
    ? 0
    : Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSq));
  const nearestX = start.x + dx * t;
  const nearestY = start.y + dy * t;
  return (x - nearestX) ** 2 + (y - nearestY) ** 2;
}

class FakeDrawingEngine {
  canEditActiveLayer(): boolean { return true; }
  strokes: Stroke[];
  redrawCount = 0;

  constructor(strokes: Stroke[]) {
    this.strokes = strokes;
  }

  getStrokes(): Stroke[] { return this.strokes; }
  addStroke(stroke: Stroke): void { this.strokes.push(stroke); }
  removeStroke(id: string): Stroke | undefined {
    const index = this.strokes.findIndex(stroke => stroke.id === id);
    return index < 0 ? undefined : this.strokes.splice(index, 1)[0];
  }
  removeStrokes(ids: Set<string>): Stroke[] {
    const removed = this.strokes.filter(stroke => ids.has(stroke.id));
    this.strokes = this.strokes.filter(stroke => !ids.has(stroke.id));
    return removed;
  }
  findStrokesNearPoint(x: number, y: number, radius: number): string[] {
    return this.strokes
      .filter(stroke => {
        const effectiveRadius = radius + getStrokeRenderHalfWidth(stroke);
        return stroke.points.slice(0, -1).some((start, index) => (
          distanceToSegmentSquared(x, y, start, stroke.points[index + 1]) <= effectiveRadius ** 2
        ));
      })
      .map(stroke => stroke.id);
  }
  redraw(): void { this.redrawCount += 1; }
  renderLiveStroke(): void {}
  commitLiveStroke(): void { this.redraw(); }
  endLiveStroke(): void {}
  renderLasso(): void {}
}

function createInputOwnershipHarness() {
  const tools = new ToolManager();
  const history = new HistoryManager();
  const drawing = new FakeDrawingEngine([]);
  const viewport = new ViewportManager();
  const layers = new LayerManager();
  const shapes: Shape[] = [];
  const shapeManager = {
    getShapes: () => shapes,
    findShapesNearPoint: () => [],
    addShape: (shape: Shape) => { shapes.push(shape); },
    removeShape: () => undefined,
    removeShapes: () => [],
    clearShapes: () => [],
  };
  const textManager = { getTexts: () => [] };
  const imageManager = { getImages: () => [] };
  const eraser = new EraserEngine(drawing as any, history);
  eraser.setShapeManager(shapeManager as any);
  const selection = new SelectionEngine(
    drawing as any,
    shapeManager as any,
    history,
    viewport,
    textManager as any,
    imageManager as any,
    layers,
  );
  const input = new InputManager(
    tools,
    viewport,
    drawing as any,
    eraser,
    shapeManager as any,
    selection,
    history,
    textManager as any,
    new RulerManager(),
    new LaserManager(),
  );
  const recognitionEvents: string[] = [];
  input.onInkStrokeLifecycle(event => recognitionEvents.push(event.type));
  const canvas = {
    clientWidth: 500,
    clientHeight: 500,
    width: 500,
    height: 500,
    style: { cursor: '', removeProperty: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 500 }),
    closest: () => null,
  } as unknown as HTMLCanvasElement;
  input.attach(canvas);

  let sampleTime = 0;
  const pointer = (phase: 'Down' | 'Move' | 'Up', x: number, y: number, shiftKey = false, buttons = phase === 'Up' ? 0 : 1) => {
    (input as any)[`handlePointer${phase}`]({
      type: `pointer${phase.toLowerCase()}`,
      timeStamp: ++sampleTime,
      button: 0,
      buttons,
      pointerId: 17,
      pointerType: 'mouse',
      pressure: 0.5,
      clientX: x,
      clientY: y,
      shiftKey,
      preventDefault: () => {},
    });
  };
  const drawLine = (y: number, startX = 50, endX = 110) => {
    pointer('Down', startX, y);
    pointer('Move', (startX + endX) / 2, y);
    pointer('Up', endX, y);
  };

  return { tools, history, drawing, selection, recognitionEvents, pointer, drawLine };
}

test('lost Windows pointer-up cannot turn later pen hover into stray ink', () => {
  const harness = createInputOwnershipHarness();
  harness.tools.setHandwritingToTextEnabled(true);
  harness.tools.setDrawingTool('pen');

  harness.pointer('Down', 40, 40);
  harness.pointer('Move', 70, 60);
  // Simulates returning from another native window after pointerup was swallowed:
  // the pointer is hovering and no physical button is held.
  harness.pointer('Move', 160, 140, false, 0);
  harness.pointer('Move', 220, 180, false, 0);

  assert.equal(harness.drawing.getStrokes().length, 0);
  assert.deepEqual(harness.recognitionEvents, ['start', 'cancel']);

  harness.drawLine(220);
  assert.equal(harness.drawing.getStrokes().length, 1);
  assert.deepEqual(harness.recognitionEvents, ['start', 'cancel', 'start', 'complete']);
});

test('Pen to Eraser to Pen keeps pointer ownership and handwriting recognition isolated', t => {
  const previousRequest = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const previousCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  // This test completes the gesture before its scheduled frame; pointerup drains it.
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  t.after(() => {
    if (previousRequest) Object.defineProperty(globalThis, 'requestAnimationFrame', previousRequest);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (previousCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', previousCancel);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  const harness = createInputOwnershipHarness();
  harness.tools.setHandwritingToTextEnabled(true);
  harness.tools.setDrawingTool('pen');
  harness.drawLine(80);
  assert.equal(harness.drawing.getStrokes().length, 1);
  assert.deepEqual(harness.recognitionEvents, ['start', 'complete']);

  harness.tools.setEraserMode('stroke');
  harness.pointer('Down', 80, 80);
  harness.pointer('Move', 85, 80);
  harness.pointer('Up', 90, 80);
  assert.equal(harness.drawing.getStrokes().length, 0);
  assert.deepEqual(harness.recognitionEvents, ['start', 'complete']);

  harness.history.undo();
  assert.equal(harness.drawing.getStrokes().length, 1, 'one Undo restores the erased stroke');
  harness.tools.setDrawingTool('pen');
  assert.equal(harness.tools.getState().handwritingToTextEnabled, true);
  harness.drawLine(130);
  assert.deepEqual(harness.recognitionEvents, ['start', 'complete', 'start', 'complete']);
});

test('Pen to Select routes a freehand lasso without adding ink or recognition events', () => {
  const harness = createInputOwnershipHarness();
  harness.tools.setHandwritingToTextEnabled(true);
  harness.tools.setDrawingTool('pencil');
  harness.drawLine(70);
  harness.drawLine(90);
  harness.drawLine(110);
  const sourceIds = harness.drawing.getStrokes().map(stroke => stroke.id);
  const recognitionCount = harness.recognitionEvents.length;

  harness.tools.setMode('select');
  harness.pointer('Down', 20, 45);
  harness.pointer('Move', 140, 45);
  harness.pointer('Move', 140, 130);
  harness.pointer('Move', 20, 130);
  harness.pointer('Up', 20, 45);

  assert.deepEqual(
    new Set(harness.selection.getSelectedElements().map(element => element.id)),
    new Set(sourceIds),
  );
  assert.equal(harness.drawing.getStrokes().length, 3, 'lasso path is transient and never persisted as ink');
  assert.equal(harness.recognitionEvents.length, recognitionCount, 'selection never enters recognition');
});

test('Select click chooses handwriting after Pen without recognition interception', () => {
  const harness = createInputOwnershipHarness();
  harness.tools.setHandwritingToTextEnabled(true);
  harness.tools.setDrawingTool('pen');
  harness.drawLine(80);
  const sourceId = harness.drawing.getStrokes()[0].id;
  const recognitionCount = harness.recognitionEvents.length;

  harness.tools.setMode('select');
  harness.pointer('Down', 80, 80);
  harness.pointer('Up', 80, 80);

  assert.deepEqual(harness.selection.getSelectedElements(), [{ type: 'stroke', id: sourceId }]);
  assert.equal(harness.recognitionEvents.length, recognitionCount);
});

test('pixel eraser splits marker continuously, retains the original ID and restores exact history', () => {
  const original: Stroke = {
    id: 'source-marker', type: 'stroke', tool: 'marker', points: [point(0), point(100)],
    color: '#000', thickness: 10, opacity: 1, createdAt: 0,
  };
  const drawing = new FakeDrawingEngine([original]);
  let historyCommand: any = null;
  const history = { pushExecuted: (command: any) => { historyCommand = command; } };
  const eraser = new EraserEngine(drawing as any, history as any);

  eraser.startErasing('pixel');
  assert.equal(eraser.eraseAt(50, 20, 'pixel', 5, false), true);
  assert.equal(drawing.redrawCount, 0, 'batched samples must not redraw individually');
  assert.equal(drawing.strokes.length, 2);
  assert.equal(drawing.strokes[0].id, original.id);
  assert.deepEqual(drawing.strokes[0].points[0], original.points[0]);
  assert.deepEqual(drawing.strokes[1].points.at(-1), original.points.at(-1));
  const retained = structuredClone(drawing.strokes);
  assert.equal(regionIntersects(strokeRegion(drawing.strokes[0]), eraserCapsule({x:50,y:20},{x:50,y:20},1)), false);
  assert.ok(drawing.strokes.every(s => s.points.every(p => p.x <= 30 || p.x >= 70)));

  assert.equal(eraser.finishErasing(), true);
  assert.ok(historyCommand);

  historyCommand.undo();
  assert.deepEqual(drawing.strokes.map(stroke => stroke.id), ['source-marker']);

  historyCommand.execute();
  assert.deepEqual(drawing.strokes, retained);
});

test('repeated pixel erasing replaces intermediate segments instead of persisting them', () => {
  const original: Stroke = {
    id: 'source-pen', type: 'stroke', tool: 'pen', points: [point(0), point(100)],
    color: '#000', thickness: 2, opacity: 1, createdAt: 0,
  };
  const drawing = new FakeDrawingEngine([original]);
  const history = { pushExecuted: (_command: any) => {} };
  const eraser = new EraserEngine(drawing as any, history as any);

  eraser.startErasing('pixel');
  eraser.eraseAt(40, 20, 'pixel', 5, false);
  eraser.eraseAt(60, 20, 'pixel', 5, false);

  assert.equal(drawing.strokes.length, 3);
  assert.equal(new Set(drawing.strokes.map(s => s.id)).size, 3);
  for (const x of [40,60]) assert.equal(drawing.strokes.some(s => regionIntersects(strokeRegion(s), eraserCapsule({x,y:20},{x,y:20},.1))), false);
  assert.ok(drawing.strokes.some(s => regionIntersects(strokeRegion(s), eraserCapsule({x:50,y:20},{x:50,y:20},1))));
});

test('highlighter-only eraser preserves ink and removes only intersecting highlights', () => {
  const pen: Stroke = {
    id: 'pen', type: 'stroke', tool: 'pen', points: [point(0), point(100)],
    color: '#111', thickness: 3, opacity: 1, createdAt: 0,
  };
  const highlighter: Stroke = {
    id: 'highlight', type: 'stroke', tool: 'highlighter', points: [point(0), point(100)],
    color: '#ff0', thickness: 12, opacity: 0.4, createdAt: 1,
  };
  const marker: Stroke = {
    id: 'marker', type: 'stroke', tool: 'marker', points: [point(0), point(100)],
    color: '#c00', thickness: 5, opacity: 0.9, createdAt: 2,
  };
  const drawing = new FakeDrawingEngine([pen, highlighter, marker]);
  let historyCommand: any = null;
  const history = { pushExecuted: (command: any) => { historyCommand = command; } };
  const eraser = new EraserEngine(drawing as any, history as any);

  eraser.startErasing('highlighter');
  assert.equal(eraser.eraseAt(50, 20, 'highlighter', 5, false), true);
  assert.deepEqual(drawing.strokes.map(stroke => stroke.id), ['pen', 'marker']);
  assert.equal(eraser.finishErasing(), true);

  historyCommand.undo();
  assert.deepEqual(new Set(drawing.strokes.map(stroke => stroke.id)), new Set(['pen', 'highlight', 'marker']));

  historyCommand.execute();
  assert.deepEqual(drawing.strokes.map(stroke => stroke.id), ['pen', 'marker']);
});

test('scribble recognition accepts a quick scratch and rejects ordinary writing strokes', () => {
  const scratch: StrokePoint[] = [
    [0, 20], [45, 17], [4, 23], [48, 18], [2, 22], [46, 16], [3, 24], [50, 20], [5, 18], [47, 23], [1, 20],
  ].map(([x, y], index) => ({ x, y, pressure: 0.5, t: index * 70 }));
  const line: StrokePoint[] = Array.from({ length: 12 }, (_, index) => ({
    x: index * 8, y: 20 + index * 0.5, pressure: 0.5, t: index * 60,
  }));

  assert.equal(analyzeScribble(scratch).isScribble, true);
  assert.equal(analyzeScribble(line).isScribble, false);
  assert.equal(analyzeScribble(scratch.map(point => ({ ...point, t: point.t * 4 }))).isScribble, false);
});

test('scribble target lookup requires repeated crossings of existing ink', () => {
  const scratch: StrokePoint[] = [
    [0, 20], [45, 17], [4, 23], [48, 18], [2, 22], [46, 16], [3, 24], [50, 20], [5, 18], [47, 23], [1, 20],
  ].map(([x, y], index) => ({ x, y, pressure: 0.5, t: index * 70 }));
  const targets = findScribbleTargets(
    scratch,
    (x) => (x >= 20 && x <= 30 ? ['crossed-ink'] : x >= 40 && x <= 41 ? ['incidental'] : []),
    3,
  );

  assert.equal(targets.has('crossed-ink'), true);
  assert.equal(targets.has('incidental'), false);
});

test('scribble erasing is one undoable command and notifies persistence on history changes', () => {
  const first: Stroke = {
    id: 'first', type: 'stroke', tool: 'pen', points: [point(0), point(100)],
    color: '#111', thickness: 3, opacity: 1, createdAt: 0,
  };
  const second: Stroke = { ...first, id: 'second', createdAt: 1 };
  const drawing = new FakeDrawingEngine([first, second]);
  let historyCommand: any = null;
  let historyNotifications = 0;
  const history = { pushExecuted: (command: any) => { historyCommand = command; } };
  const eraser = new EraserEngine(drawing as any, history as any);
  eraser.setHistoryChangeCallback(() => { historyNotifications += 1; });

  assert.equal(eraser.eraseStrokeIds(new Set(['first'])), true);
  assert.deepEqual(drawing.strokes.map(stroke => stroke.id), ['second']);
  assert.ok(historyCommand);

  historyCommand.undo();
  assert.deepEqual(new Set(drawing.strokes.map(stroke => stroke.id)), new Set(['first', 'second']));
  historyCommand.execute();
  assert.deepEqual(drawing.strokes.map(stroke => stroke.id), ['second']);
  assert.equal(historyNotifications, 2);
});

test('circle-to-select recognition accepts a closed loop and rejects open or slow strokes', () => {
  const circle: StrokePoint[] = Array.from({ length: 33 }, (_, index) => {
    const angle = (index / 32) * Math.PI * 2;
    return { x: 100 + Math.cos(angle) * 55, y: 80 + Math.sin(angle) * 38, pressure: 0.5, t: index * 45 };
  });
  const open = circle.slice(0, 24);
  const slow = circle.map(point => ({ ...point, t: point.t * 3 }));

  assert.equal(analyzeCircleGesture(circle).isCircle, true);
  assert.equal(analyzeCircleGesture(open).isCircle, false);
  assert.equal(analyzeCircleGesture(slow).isCircle, false);
});

test('circle-to-select polygon containment distinguishes enclosed and outside object centers', () => {
  const circle: StrokePoint[] = Array.from({ length: 33 }, (_, index) => {
    const angle = (index / 32) * Math.PI * 2;
    return { x: 100 + Math.cos(angle) * 55, y: 80 + Math.sin(angle) * 38, pressure: 0.5, t: index * 45 };
  });

  assert.equal(isPointInsideLoop(100, 80, circle), true);
  assert.equal(isPointInsideLoop(170, 80, circle), false);
});

test('straight-line recognition accepts sufficiently long low-deviation strokes', () => {
  const points: StrokePoint[] = Array.from({ length: 14 }, (_, index) => ({
    x: index * 8,
    y: 20 + (index % 2 === 0 ? 0.35 : -0.35),
    pressure: 0.5,
    t: index * 24,
  }));
  const result = recognizeStraightLine(points, false);

  assert.equal(result.isLine, true);
  assert.equal(result.points.length, 2);
  assert.equal(result.snappedAngle, null);
  assert.ok(result.efficiency > 0.98);
});

test('straight-line recognition snaps conservatively to horizontal, vertical, and 45 degrees', () => {
  const makeLine = (endX: number, endY: number): StrokePoint[] => Array.from({ length: 12 }, (_, index) => ({
    x: (endX * index) / 11,
    y: (endY * index) / 11,
    pressure: 0.5,
    t: index * 25,
  }));
  const horizontal = recognizeStraightLine(makeLine(100, 5), true);
  const vertical = recognizeStraightLine(makeLine(4, 100), true);
  const diagonal = recognizeStraightLine(makeLine(100, 94), true);
  const unsnapped = recognizeStraightLine(makeLine(100, 12), true);

  assert.equal(horizontal.points[1].y, 0);
  assert.ok(Math.abs(vertical.points[1].x) < 1e-9);
  assert.ok(Math.abs(diagonal.points[1].x - diagonal.points[1].y) < 1e-9);
  assert.equal(unsnapped.snappedAngle, null);
  assert.equal(unsnapped.points[1].y, 12);
});

test('straight-line recognition rejects short, curvy, handwriting-like, and bent strokes', () => {
  const short = Array.from({ length: 8 }, (_, index) => ({ x: index * 5, y: 20, pressure: 0.5, t: index * 25 }));
  const curvy = Array.from({ length: 20 }, (_, index) => ({ x: index * 7, y: 30 + Math.sin(index / 2) * 14, pressure: 0.5, t: index * 25 }));
  const handwriting = Array.from({ length: 18 }, (_, index) => ({ x: index * 6, y: 30 + (index % 3) * 8, pressure: 0.5, t: index * 28 }));
  const bent = [
    { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }, { x: 80, y: 18 }, { x: 100, y: 38 },
  ].map((point, index) => ({ ...point, pressure: 0.5, t: index * 90 }));

  assert.equal(recognizeStraightLine(short, true).isLine, false);
  assert.equal(recognizeStraightLine(curvy, true).isLine, false);
  assert.equal(recognizeStraightLine(handwriting, true).isLine, false);
  assert.equal(recognizeStraightLine(bent, true).isLine, false);
});

function roughEllipse(width: number, height: number, pointCount = 49): StrokePoint[] {
  return Array.from({ length: pointCount }, (_, index) => {
    const angle = (index / (pointCount - 1)) * Math.PI * 2;
    const wobble = 1 + Math.sin(angle * 5) * 0.035 + Math.sin(angle * 9) * 0.012;
    return {
      x: 120 + Math.cos(angle) * width / 2 * wobble,
      y: 100 + Math.sin(angle) * height / 2 * wobble,
      pressure: 0.5,
      t: index * 30,
    };
  });
}

function roughRectangle(width: number, height: number, pointsPerEdge = 10): StrokePoint[] {
  const corners = [[20, 30], [20 + width, 30], [20 + width, 30 + height], [20, 30 + height], [20, 30]];
  const points: StrokePoint[] = [];
  for (let edge = 0; edge < 4; edge += 1) {
    const [startX, startY] = corners[edge];
    const [endX, endY] = corners[edge + 1];
    for (let index = 0; index < pointsPerEdge; index += 1) {
      const progress = index / pointsPerEdge;
      const wobble = Math.sin(progress * Math.PI * 3) * 1.1;
      const horizontal = startY === endY;
      points.push({
        x: startX + (endX - startX) * progress + (horizontal ? 0 : wobble),
        y: startY + (endY - startY) * progress + (horizontal ? wobble : 0),
        pressure: 0.5,
        t: points.length * 34,
      });
    }
  }
  points.push({ x: corners[0][0], y: corners[0][1], pressure: 0.5, t: points.length * 34 });
  return points;
}

test('rough-shape recognition converts a deliberate rough circle or ellipse', () => {
  const result = recognizeRoughShape(roughEllipse(124, 82), false);

  assert.equal(result.isShape, true);
  assert.equal(result.shapeType, 'ellipse');
  assert.equal(result.snapped, false);
  assert.ok(result.width > result.height);
});

test('rough-shape recognition converts a deliberate rough rectangle', () => {
  const result = recognizeRoughShape(roughRectangle(132, 78), false);

  assert.equal(result.isShape, true);
  assert.equal(result.shapeType, 'rectangle');
  assert.equal(result.snapped, false);
  assert.ok(result.width > result.height);
});

test('rough-shape recognition optionally snaps near-equal ellipses and rectangles', () => {
  const circle = recognizeRoughShape(roughEllipse(104, 96), true);
  const square = recognizeRoughShape(roughRectangle(106, 96), true);
  const clearEllipse = recognizeRoughShape(roughEllipse(140, 84), true);

  assert.equal(circle.shapeType, 'ellipse');
  assert.equal(circle.snapped, true);
  assert.equal(circle.width, circle.height);
  assert.equal(square.shapeType, 'rectangle');
  assert.equal(square.snapped, true);
  assert.equal(square.width, square.height);
  assert.equal(clearEllipse.snapped, false);
});

test('rough-shape recognition rejects open, small, and handwriting-like ambiguous loops', () => {
  const openStroke = roughEllipse(120, 90).slice(0, 37);
  const smallLoop = roughEllipse(34, 22);
  const figureEight: StrokePoint[] = Array.from({ length: 49 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2;
    return {
      x: 100 + Math.sin(angle) * 62,
      y: 90 + Math.sin(angle * 2) * 44,
      pressure: 0.5,
      t: index * 30,
    };
  });

  assert.equal(recognizeRoughShape(openStroke, true).isShape, false);
  assert.equal(recognizeRoughShape(smallLoop, true).isShape, false);
  assert.equal(recognizeRoughShape(figureEight, true).isShape, false);
});

test('rough-shape recognition does not preempt existing scribble, circle-select, or straight-line classifiers', () => {
  const scratch: StrokePoint[] = [
    [0, 20], [45, 17], [4, 23], [48, 18], [2, 22], [46, 16], [3, 24], [50, 20], [5, 18], [47, 23], [1, 20],
  ].map(([x, y], index) => ({ x, y, pressure: 0.5, t: index * 70 }));
  const circle = roughEllipse(110, 86);
  const line = Array.from({ length: 14 }, (_, index) => ({
    x: index * 8,
    y: 20 + (index % 2 === 0 ? 0.25 : -0.25),
    pressure: 0.5,
    t: index * 24,
  }));

  assert.equal(analyzeScribble(scratch).isScribble, true);
  assert.equal(recognizeRoughShape(scratch, true).isShape, false);
  assert.equal(analyzeCircleGesture(circle).isCircle, true);
  assert.equal(recognizeRoughShape(circle, false).shapeType, 'ellipse');
  assert.equal(recognizeStraightLine(line, true).isLine, true);
  assert.equal(recognizeRoughShape(line, true).isShape, false);
});

function selectionShape(id: string, x: number, y: number, width = 32, height = 24): Shape {
  return {
    id,
    type: 'shape',
    shapeType: 'rectangle',
    x,
    y,
    width,
    height,
    color: '#111111',
    strokeWidth: 2,
    fill: null,
    rotation: 0,
    createdAt: 0,
  };
}

function createLassoHarness(shapes: Shape[], strokes: Stroke[] = [], images: ImageObject[] = []) {
  const lassoFrames: StrokePoint[][] = [];
  let redraws = 0;
  const drawing = {
    getStrokes: () => strokes,
    findStrokesNearPoint: (x: number, y: number, radius: number) => strokes
      .filter(stroke => stroke.points.some(point => Math.hypot(point.x - x, point.y - y) <= radius))
      .map(stroke => stroke.id),
    redraw: () => { redraws += 1; },
    renderLasso: (points: StrokePoint[]) => {
      lassoFrames.push(points.map(point => ({ ...point })));
    },
  };
  const shapeManager = {
    getShapes: () => shapes,
    findShapesNearPoint: (x: number, y: number, radius: number) => shapes
      .filter(shape => (
        x >= shape.x - radius
        && x <= shape.x + shape.width + radius
        && y >= shape.y - radius
        && y <= shape.y + shape.height + radius
      ))
      .map(shape => shape.id),
  };
  const history = new HistoryManager();
  const viewport = {
    canvasToPage: (x: number, y: number) => ({ x, y }),
    getState: () => ({ offsetX: 0, offsetY: 0, scale: 1 }),
    applyTransform: () => {},
  };
  const textManager = { getTexts: () => [] };
  const imageManager = { getImages: () => images };
  const layers = new LayerManager();
  const selection = new SelectionEngine(
    drawing as any,
    shapeManager as any,
    history as any,
    viewport as any,
    textManager as any,
    imageManager as any,
    layers,
  );
  const input = new InputManager(
    {} as any,
    viewport as any,
    drawing as any,
    { setHistoryChangeCallback: () => {}, setRulerManager: () => {} } as any,
    shapeManager as any,
    selection,
    history as any,
    textManager as any,
    new RulerManager(),
    new LaserManager(),
  );
  (input as any).canvas = {
    clientWidth: 500,
    clientHeight: 500,
    width: 500,
    height: 500,
    style: { removeProperty: () => {} },
    setPointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 500 }),
  };

  const pointer = (method: 'startSelection' | 'continueSelection' | 'finishSelection', x: number, y: number, shiftKey = false) => {
    (input as any)[method]({
      pointerId: 1,
      pointerType: 'mouse',
      pressure: 0.5,
      clientX: x,
      clientY: y,
      shiftKey,
    });
  };

  return { selection, history, lassoFrames, pointer, getRedraws: () => redraws };
}

test('freehand lasso drag selects multiple enclosed objects', () => {
  const harness = createLassoHarness([
    selectionShape('inside-a', 32, 38),
    selectionShape('inside-b', 112, 104),
    selectionShape('outside', 280, 260),
  ]);

  harness.pointer('startSelection', 5, 5);
  harness.pointer('continueSelection', 190, 5);
  harness.pointer('continueSelection', 190, 190);
  harness.pointer('continueSelection', 5, 190);
  harness.pointer('finishSelection', 5, 5);

  assert.deepEqual(
    new Set(harness.selection.getSelectedElements().map(element => element.id)),
    new Set(['inside-a', 'inside-b']),
  );
  assert.ok(harness.lassoFrames.some(points => points.length >= 4));
  assert.ok(harness.getRedraws() > 0);
});

test('empty-canvas selection click clears the active selection', () => {
  const harness = createLassoHarness([selectionShape('selected', 30, 30)]);
  assert.equal(harness.selection.selectAt(40, 40), true);

  harness.pointer('startSelection', 300, 300);
  harness.pointer('finishSelection', 300, 300);

  assert.equal(harness.selection.getSelectedElements().length, 0);
});

test('Shift plus empty-canvas selection click preserves the active selection', () => {
  const harness = createLassoHarness([selectionShape('selected', 30, 30)]);
  assert.equal(harness.selection.selectAt(40, 40), true);

  harness.pointer('startSelection', 300, 300, true);
  harness.pointer('finishSelection', 300, 300, true);

  assert.deepEqual(harness.selection.getSelectedElements().map(element => element.id), ['selected']);
});

test('single click-to-select still selects an element without starting a lasso', () => {
  const harness = createLassoHarness([selectionShape('clicked', 30, 30)]);

  harness.pointer('startSelection', 40, 40);
  harness.pointer('finishSelection', 40, 40);

  assert.deepEqual(harness.selection.getSelectedElements().map(element => element.id), ['clicked']);
  assert.equal(harness.lassoFrames.length, 0);
});

test('common transform rotation handle rotates a shape with undo and redo', () => {
  const shape = selectionShape('rotate-me', 80, 80);
  const harness = createLassoHarness([shape]);
  harness.selection.selectElement(shape.id, 'shape');
  const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
  harness.selection.startDrag(center.x, shape.y - 32);
  harness.selection.dragTo(center.x + 32, center.y);
  assert.ok(Math.abs(shape.rotation - 90) < 0.001);
  assert.equal(harness.selection.finishDrag(center.x + 32, center.y), true);
  harness.history.undo();
  assert.equal(shape.rotation, 0);
  harness.history.redo();
  assert.ok(Math.abs(shape.rotation - 90) < 0.001);
});

test('images use the common rotation handle and persist undoable opacity', () => {
  const image: ImageObject = {
    id: 'rotate-image', type: 'image', x: 80, y: 80, width: 100, height: 60,
    fileId: 'fixture-image', rotation: 0, opacity: 1, createdAt: 0, layerId: 'layer-default',
  };
  const harness = createLassoHarness([], [], [image]);
  harness.selection.selectElement(image.id, 'image');
  const center = { x: image.x + image.width / 2, y: image.y + image.height / 2 };
  harness.selection.startDrag(center.x, image.y - 32);
  harness.selection.dragTo(center.x + 32, center.y);
  assert.ok(Math.abs(image.rotation - 90) < 0.001);
  assert.equal(harness.selection.finishDrag(center.x + 32, center.y), true);

  assert.equal(harness.selection.changeOpacity(0.35), true);
  assert.equal(image.opacity, 0.35);
  harness.history.undo();
  assert.equal(image.opacity, 1);
  harness.history.undo();
  assert.equal(image.rotation, 0);
  harness.history.redo();
  assert.ok(Math.abs(image.rotation - 90) < 0.001);
  harness.history.redo();
  assert.equal(image.opacity, 0.35);
  assert.equal(JSON.parse(JSON.stringify(image)).opacity, 0.35);
});

test('rotated resize converts pointer movement into object-local axes', () => {
  const shape = { ...selectionShape('resize-me', 80, 80, 80, 40), rotation: 90 };
  const harness = createLassoHarness([shape]);
  harness.selection.selectElement(shape.id, 'shape');
  const localBottomRight = { x: shape.x + shape.width + 4, y: shape.y + shape.height + 4 };
  const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
  const rotate = (point: typeof center) => ({ x: center.x - (point.y - center.y), y: center.y + (point.x - center.x) });
  const handle = rotate(localBottomRight);
  harness.selection.startDrag(handle.x, handle.y);
  harness.selection.dragTo(handle.x, handle.y + 30);
  assert.ok(shape.width > 100, 'world-down movement grows local width at 90 degrees');
  assert.equal(shape.height, 40);
});

test('resizing clipped ink scales its ruler-protected region and undo restores it', () => {
  const stroke: Stroke = {
    id: 'clipped-stroke', type: 'stroke', tool: 'marker', color: '#5522aa', thickness: 20,
    opacity: 0.5, createdAt: 0, layerId: 'layer-default',
    points: [
      { x: 20, y: 20, pressure: 0.5, t: 0 },
      { x: 120, y: 20, pressure: 0.5, t: 1 },
      { x: 120, y: 70, pressure: 0.5, t: 2 },
    ],
    inkClip: [[[[0, 0], [50, 0], [50, 20], [0, 20], [0, 0]]]],
  };
  const harness = createLassoHarness([], [stroke]);
  harness.selection.selectElement(stroke.id, 'stroke');
  harness.selection.startDrag(124, 74);
  harness.selection.dragTo(224, 124);
  assert.deepEqual(stroke.inkClip?.[0]?.[0]?.[1], [100, 0]);
  assert.equal(harness.selection.finishDrag(224, 124), true);
  harness.history.undo();
  assert.deepEqual(stroke.inkClip?.[0]?.[0]?.[1], [50, 0]);
  harness.history.redo();
  assert.deepEqual(stroke.inkClip?.[0]?.[0]?.[1], [100, 0]);
});

function createRulerInputHarness(rulerEnabled: boolean, strokePattern: 'solid' | 'dashed' | 'dotted' = 'solid') {
  const ruler = new RulerManager();
  ruler.setEnabled(rulerEnabled);
  const strokes: Stroke[] = [];
  const historyCommands: any[] = [];
  let redraws = 0;
  const toolState = { ...DEFAULT_TOOL_STATE, mode: 'draw' as const, rulerEnabled, stabilization: 0, strokePattern };
  const drawing = {
    getRulerManager: () => ruler,
    canEditActiveLayer: () => true,
    getStrokes: () => strokes,
    findStrokesNearPoint: () => [],
    addStroke: (stroke: Stroke) => { strokes.push(stroke); },
    removeStroke: (id: string) => {
      const index = strokes.findIndex(stroke => stroke.id === id);
      if (index >= 0) strokes.splice(index, 1);
    },
    redraw: () => { redraws += 1; },
    renderLiveStroke: () => {},
    commitLiveStroke: () => { redraws++; },
    endLiveStroke: () => {},
  };
  const history = {
    pushExecuted: (command: any) => { historyCommands.push(command); },
  };
  const viewport = new ViewportManager();
  const input = new InputManager(
    { getState: () => toolState } as any,
    viewport,
    drawing as any,
    { setHistoryChangeCallback: () => {}, setRulerManager: () => {}, eraseStrokeIds: () => false } as any,
    { addShape: () => {} } as any,
    { selectWithinLoop: () => 0 } as any,
    history as any,
    {} as any,
    ruler,
    new LaserManager(),
  );
  (input as any).canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    style: { removeProperty: () => {} },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };

  let sampleTime = 0;
  const pointer = (phase: 'Down' | 'Move' | 'Up', x: number, y: number) => {
    (input as any)[`handlePointer${phase}`]({
      type: `pointer${phase.toLowerCase()}`,
      timeStamp: ++sampleTime,
      button: 0,
      pointerId: 7,
      pointerType: 'mouse',
      pressure: 0.5,
      clientX: x,
      clientY: y,
      shiftKey: false,
      preventDefault: () => {},
    });
  };

  return { ruler, strokes, historyCommands, pointer, getRedraws: () => redraws };
}

test('drawing commits the selected vector stroke pattern for persistence', () => {
  const harness = createRulerInputHarness(false, 'dotted');
  harness.pointer('Down', 20, 20);
  harness.pointer('Move', 80, 40);
  harness.pointer('Up', 80, 40);
  assert.equal(harness.strokes.length, 1);
  assert.equal(harness.strokes[0].pattern, 'dotted');
  harness.historyCommands[0].undo();
  assert.equal(harness.strokes.length, 0);
  harness.historyCommands[0].execute();
  assert.equal(harness.strokes[0].pattern, 'dotted');
});

test('ruler edge projection uses page coordinates after viewport scale conversion', () => {
  const viewport = new ViewportManager();
  viewport.setRenderTransform({ scale: true });
  viewport.setZoom(2);
  const ruler = new RulerManager();
  ruler.setEnabled(true);
  ruler.setCenter(200, 100);

  const pagePoint = viewport.canvasToPage(600, 144);
  const source: StrokePoint = { ...pagePoint, pressure: 0.7, t: 42 };
  const result = ruler.snapPointToEdge(source, 20);

  assert.deepEqual(pagePoint, { x: 300, y: 72 });
  assert.equal(result.isSnapped, true);
  assert.equal(result.edge, 'top');
  assert.equal(result.point.x, 300);
  assert.equal(result.point.y, 68);
  assert.equal(result.point.pressure, 0.7);
  assert.equal(result.point.t, 42);
});

test('ruler movement and rotation capture input without creating ink or history', () => {
  const harness = createRulerInputHarness(true);
  const initial = harness.ruler.getState();

  harness.pointer('Down', initial.center.x, initial.center.y);
  harness.pointer('Move', initial.center.x + 40, initial.center.y + 25);
  harness.pointer('Up', initial.center.x + 40, initial.center.y + 25);
  assert.deepEqual(harness.ruler.getState().center, {
    x: initial.center.x + 40,
    y: initial.center.y + 25,
  });

  const moved = harness.ruler.getState();
  const handle = harness.ruler.getRotationHandle();
  const handleRadius = Math.hypot(handle.x - moved.center.x, handle.y - moved.center.y);
  harness.pointer('Down', handle.x, handle.y);
  harness.pointer(
    'Move',
    moved.center.x + Math.cos(-Math.PI / 4) * handleRadius,
    moved.center.y + Math.sin(-Math.PI / 4) * handleRadius,
  );
  harness.pointer(
    'Up',
    moved.center.x + Math.cos(-Math.PI / 4) * handleRadius,
    moved.center.y + Math.sin(-Math.PI / 4) * handleRadius,
  );

  assert.ok(Math.abs(harness.ruler.getState().angle - Math.PI / 4) < 1e-9);
  assert.equal(harness.strokes.length, 0);
  assert.equal(harness.historyCommands.length, 0);
  assert.ok(harness.getRedraws() > 0);
});

test('ruler rotation snaps conservatively to canonical 0, 45, and 90 degree angles', () => {
  const ruler = new RulerManager();

  assert.equal(ruler.setAngle(2 * Math.PI / 180), 0);
  assert.equal(ruler.setAngle(47 * Math.PI / 180), Math.PI / 4);
  assert.equal(ruler.setAngle(88 * Math.PI / 180), Math.PI / 2);
  assert.ok(Math.abs(ruler.setAngle(50 * Math.PI / 180) - 50 * Math.PI / 180) < 1e-9);
});

test('ruler uses print-scale millimetres and resizes only within the active page length', () => {
  const ruler = new RulerManager();
  ruler.setEnabled(true);
  ruler.setCenter(500, 300);

  // CSS print resolution is 96 dpi: 100 mm is approximately 377.95 px.
  ruler.setMaxLength(900);
  ruler.setWidth(100 * 96 / 25.4);
  const state = ruler.getState();
  assert.ok(Math.abs(state.width - 100 * 96 / 25.4) < 1e-9);
  assert.equal(ruler.hitTest(state.center.x - state.width / 2 + 2, state.center.y), 'resize-start');
  assert.equal(ruler.hitTest(state.center.x + state.width / 2 - 2, state.center.y), 'resize-end');

  ruler.setWidth(2_000);
  assert.equal(ruler.getState().width, 900);
  ruler.setWidth(1);
  assert.ok(Math.abs(ruler.getState().width - 50 * 96 / 25.4) < 1e-9);
});

test('ruler protects its surface from an eraser radius whose center is outside the ruler', () => {
  const ruler = new RulerManager();
  ruler.setEnabled(true);
  ruler.setCenter(500, 300);
  ruler.setWidth(400);
  const halfHeight = ruler.getState().height / 2;

  assert.equal(ruler.hitTest(500, 300 + halfHeight + 8), null);
  assert.equal(ruler.intersectsCircle(500, 300 + halfHeight + 8, 12), true);
  assert.equal(ruler.intersectsCircle(500, 300 + halfHeight + 20, 12), false);
});

test('ruler mask subtracts the full body from a large eraser disk', () => {
  const ruler = new RulerManager();
  ruler.setEnabled(true);
  ruler.setCenter(500, 300);
  ruler.setWidth(400);
  const exposed = exposedEraser(eraserCapsule({x:500,y:300},{x:500,y:300},100), ruler.getBodyPolygon());
  assert.equal(regionIntersects(exposed, ruler.getBodyPolygon()), false);
  for (const y of [266,334]) assert.ok(regionIntersects(exposed, eraserCapsule({x:500,y},{x:500,y},.1)));
});

test('ruler-guided erase uses ruler-local coordinates after rotation', () => {
  const ruler = new RulerManager();
  ruler.setEnabled(true);
  ruler.setCenter(500, 300);
  ruler.setWidth(400);
  ruler.setAngle(Math.PI / 2, false);
  const exposed = exposedEraser(eraserCapsule({x:420,y:300},{x:580,y:300},100), ruler.getBodyPolygon());
  assert.equal(regionIntersects(exposed, ruler.getBodyPolygon()), false);
  for (const x of [466,534]) assert.ok(regionIntersects(exposed, eraserCapsule({x,y:300},{x,y:300},.1)));
});

test('drawing with the ruler disabled preserves normal freehand points', () => {
  const harness = createRulerInputHarness(false);
  const center = harness.ruler.getState().center;

  harness.pointer('Down', center.x, center.y);
  harness.pointer('Move', center.x + 35, center.y + 22);
  harness.pointer('Up', center.x + 35, center.y + 22);

  assert.equal(harness.strokes.length, 1);
  assert.deepEqual(
    harness.strokes[0].points.map(point => ({ x: point.x, y: point.y })),
    [center, { x: center.x + 35, y: center.y + 22 }],
  );
  assert.equal(harness.historyCommands.length, 1);
});

test('ruler constrains only stroke samples within the active edge threshold', () => {
  const harness = createRulerInputHarness(true);
  const state = harness.ruler.getState();
  const topEdgeY = state.center.y - state.height / 2;

  harness.pointer('Down', state.center.x - 120, topEdgeY - 8);
  harness.pointer('Move', state.center.x - 40, topEdgeY - 4);
  harness.pointer('Move', state.center.x + 30, topEdgeY - 48);
  harness.pointer('Up', state.center.x + 30, topEdgeY - 48);

  assert.equal(harness.strokes.length, 1);
  assert.deepEqual(
    harness.strokes[0].points.map(point => ({ x: point.x, y: point.y })),
    [
      { x: state.center.x - 120, y: topEdgeY },
      { x: state.center.x - 40, y: topEdgeY },
      { x: state.center.x + 30, y: topEdgeY - 48 },
    ],
  );
});

test('ruler geometry stays transient and disabling removes its interaction surface', () => {
  const ruler = new RulerManager();
  ruler.setEnabled(true);
  ruler.setCenter(480, 260);
  ruler.setAngle(Math.PI / 3);
  assert.equal(ruler.hitTest(480, 260), 'move');

  ruler.setEnabled(false);
  assert.equal(ruler.getState().enabled, false);
  assert.equal(ruler.hitTest(480, 260), null);
  assert.equal(ruler.snapPointToEdge({ x: 480, y: 260, pressure: 0.5, t: 0 }).isSnapped, false);
  const persistedPage = createEmptyDrawingData() as Record<string, unknown>;
  assert.equal('ruler' in persistedPage, false);
  assert.equal('rulerState' in persistedPage, false);
});

function createLaserScheduler() {
  let now = 0;
  let nextHandle = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  return {
    options: {
      now: () => now,
      requestFrame: (callback: FrameRequestCallback) => {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle: number) => {
        cancelled.push(handle);
        frames.delete(handle);
      },
    },
    setNow: (value: number) => { now = value; },
    getPendingCount: () => frames.size,
    getCancelledCount: () => cancelled.length,
  };
}

test('laser trail inserts page points and calculates timestamp-based decay', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, decayMs: 1_000 });

  laser.addPoint({ x: 20, y: 30, pressure: 0.5, t: 0 });
  scheduler.setNow(400);
  laser.addPoint({ x: 80, y: 60, pressure: 0.5, t: 400 });
  assert.deepEqual(laser.getActiveTrail().map(({ x, y, timestamp }) => ({ x, y, timestamp })), [
    { x: 20, y: 30, timestamp: 0 },
    { x: 80, y: 60, timestamp: 400 },
  ]);

  scheduler.setNow(500);
  assert.equal(laser.getPointOpacity(laser.getActiveTrail()[0]), 0.5);
  scheduler.setNow(1_001);
  assert.deepEqual(laser.getActiveTrail().map(point => point.timestamp), [400]);
  scheduler.setNow(1_401);
  assert.equal(laser.getActiveTrail().length, 0);
  assert.equal(scheduler.getPendingCount(), 1);
  laser.clear();
  assert.equal(scheduler.getPendingCount(), 0);
});

function createLaserInputHarness() {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager(scheduler.options);
  const tools = new ToolManager();
  const history = new HistoryManager();
  const strokes: Stroke[] = [];
  let redraws = 0;
  let changes = 0;
  laser.setRedrawCallback(() => { redraws += 1; });
  tools.setDrawingTool('laser');

  const drawing = {
    getStrokes: () => strokes,
    findStrokesNearPoint: () => [],
    addStroke: (stroke: Stroke) => { strokes.push(stroke); },
    removeStroke: () => undefined,
    redraw: () => { redraws += 1; },
    renderLiveStroke: () => {},
    commitLiveStroke: () => {},
    endLiveStroke: () => {},
    renderLasso: () => {},
  };
  const input = new InputManager(
    tools,
    new ViewportManager(),
    drawing as any,
    { setHistoryChangeCallback: () => {}, setRulerManager: () => {}, eraseStrokeIds: () => false } as any,
    { addShape: () => {} } as any,
    { selectWithinLoop: () => 0 } as any,
    history,
    {} as any,
    new RulerManager(),
    laser,
  );
  input.onDrawingChange(() => { changes += 1; });

  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    style: { cursor: '', removeProperty: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLCanvasElement;
  input.attach(canvas);

  const pointer = (phase: 'Down' | 'Move' | 'Up', x: number, y: number) => {
    (input as any)[`handlePointer${phase}`]({
      button: 0,
      pointerId: 11,
      pointerType: 'mouse',
      pressure: 0.5,
      clientX: x,
      clientY: y,
      shiftKey: false,
      preventDefault: () => {},
    });
  };

  return {
    input,
    laser,
    tools,
    history,
    strokes,
    scheduler,
    pointer,
    getChanges: () => changes,
    getRedraws: () => redraws,
  };
}

test('laser input creates no permanent stroke, persistence change, or undo record', () => {
  const harness = createLaserInputHarness();
  const persistedBefore = JSON.stringify(createEmptyDrawingData());

  harness.pointer('Down', 110, 140);
  harness.pointer('Move', 150, 180);
  harness.pointer('Up', 190, 200);

  assert.deepEqual(
    harness.laser.getActiveTrail().map(point => ({ x: Math.round(point.x), y: Math.round(point.y) })),
    [{ x: 110, y: 140 }, { x: 150, y: 180 }, { x: 190, y: 200 }],
  );
  assert.equal(harness.strokes.length, 0);
  assert.equal(harness.history.canUndo(), false);
  assert.equal(harness.getChanges(), 0);
  assert.equal(JSON.stringify(createEmptyDrawingData()), persistedBefore);
  assert.equal('laser' in (createEmptyDrawingData() as Record<string, unknown>), false);
  harness.input.detach();
});

test('switching away from laser clears trail and cancels transient animation', () => {
  const harness = createLaserInputHarness();
  harness.pointer('Down', 90, 90);
  harness.pointer('Move', 120, 120);
  assert.equal(harness.laser.getActiveTrail().length, 2);
  assert.equal(harness.laser.isAnimating(), true);

  harness.tools.setDrawingTool('pen');

  assert.equal(harness.laser.getActiveTrail().length, 0);
  assert.equal(harness.laser.isAnimating(), false);
  assert.equal(harness.scheduler.getCancelledCount(), 1);
  assert.equal(harness.strokes.length, 0);
  assert.equal(harness.getChanges(), 0);
  assert.ok(harness.getRedraws() > 0);
  harness.input.detach();
});

test('crop preserves rotated placement and restores original asset with undo', () => {
  const image: ImageObject = { id: 'crop-image', type: 'image', x: 80, y: 80, width: 100, height: 60,
    fileId: 'original', rotation: 90, opacity: 0.4, createdAt: 0, layerId: 'layer-default' };
  const harness = createLassoHarness([], [], [image]);
  harness.selection.selectElement(image.id, 'image');
  const before = { ...image };
  assert.equal(harness.selection.cropImage(image.id, { x: 0.2, y: 0, width: 0.8, height: 1 }), true);
  assert.equal(image.fileId, 'original');
  assert.equal(image.width, 80);
  assert.ok(Math.abs(image.x - 90) < 1e-9);
  assert.ok(Math.abs(image.y - 90) < 1e-9);
  assert.equal(image.opacity, 0.4);
  const after = { ...image };
  harness.history.undo();
  assert.deepEqual(image, before);
  harness.history.redo();
  assert.deepEqual(image, after);
  assert.equal(harness.selection.cropImage(image.id, { x: 0, y: 0, width: 0, height: 1 }), false);
  assert.deepEqual(image, after);
});

test('image overlay coordinates round-trip across PDF rotation, pan, and zoom', () => {
  const viewport = new ViewportManager();
  for (const rotation of [0, 90, 180, 270] as const) {
    viewport.setPdfPageRotation(rotation, 800, 1000);
    for (const scale of [0.5, 1, 2]) {
      viewport.setZoom(scale);
      viewport.setPan(35, -20);
      for (const renderScale of [false, true]) {
        viewport.setRenderTransform({ pan: true, scale: renderScale });
        const screen = viewport.pageToCanvas(123, 456);
        const page = viewport.canvasToPage(screen.x, screen.y);
        assert.ok(Math.abs(page.x - 123) < 1e-9);
        assert.ok(Math.abs(page.y - 456) < 1e-9);
      }
    }
  }
});


test('line-style changes preserve geometry and undo through the existing shape history', () => {
  const line: Shape = { id: 'styled-line', type: 'shape', createdAt: 1, shapeType: 'line', x: 20, y: 40, width: 200, height: 80, rotation: 37, color: '#000000', fill: null, strokeWidth: 3 };
  const harness = createLassoHarness([line]);
  harness.selection.selectElement(line.id, 'shape');
  harness.selection.changeLineStyle('wavy');
  assert.equal(line.lineStyle, 'wavy');
  assert.equal(line.rotation, 37); assert.equal(line.x, 20);
  harness.history.undo(); assert.equal(line.lineStyle, undefined);
  harness.history.redo(); assert.equal(line.lineStyle, 'wavy');
});
