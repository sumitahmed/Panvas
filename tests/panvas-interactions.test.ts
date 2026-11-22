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
import { AllSelection, NodeSelection } from '@tiptap/pm/state';
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
import { ShapeManager } from '../src/components/notebook/engine/ShapeManager.ts';
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

test('formatting sessions retain native all/node selections and backward text direction', () => {
  const editor = createEditor();
  editor.commands.selectAll();
  runFormattingCommand(editor, captureFormattingSelection(editor), chain => chain.toggleBold());
  assert.ok(editor.state.selection instanceof AllSelection);
  editor.commands.setTextSelection({ from: 6, to: 1 });
  const backward = captureFormattingSelection(editor);
  editor.commands.setTextSelection(8);
  runFormattingCommand(editor, backward, chain => chain.toggleItalic());
  assert.equal(editor.state.selection.anchor, 6); assert.equal(editor.state.selection.head, 1);
  editor.commands.setContent({ type: 'doc', content: [{ type: 'horizontalRule' }, { type: 'paragraph' }] });
  editor.commands.setNodeSelection(0); const node = captureFormattingSelection(editor);
  editor.commands.setTextSelection(2);
  runFormattingCommand(editor, node, chain => chain.command(({ tr }: any) => {
    assert.ok(tr.selection instanceof NodeSelection); return true;
  }));
  assert.ok(editor.state.selection instanceof NodeSelection);
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
  // The zoom ceiling is 800% and every entry point shares one clamp.
  viewport.setZoom(16);
  assert.equal(viewport.getState().scale, 8);
  viewport.setZoom(6);
  assert.equal(viewport.getState().scale, 6);
  viewport.zoomBy(10, 0, 0);
  assert.equal(viewport.getState().scale, 8, 'zoomBy shares the 800% ceiling');
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
  const toolManager = { state: { mode: 'select', selectionShape: 'freeform' } as any, getState: function () { return this.state; } };
  const input = new InputManager(
    toolManager as any,
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

  return { selection, history, lassoFrames, pointer, tools: toolManager as any, getRedraws: () => redraws };
}

test('selection handles are hit-tested exactly where they are drawn', () => {
  const shape = selectionShape('handle-alignment', 100, 100, 120, 60);
  const harness = createLassoHarness([shape]);
  harness.selection.selectElement(shape.id, 'shape');
  // Handles anchor on the dashed frame, 4 page units beyond the logical box.
  const frameCorners: Array<{ handle: string; x: number; y: number }> = [
    { handle: 'tl', x: shape.x - 4, y: shape.y - 4 },
    { handle: 'tr', x: shape.x + shape.width + 4, y: shape.y - 4 },
    { handle: 'bl', x: shape.x - 4, y: shape.y + shape.height + 4 },
    { handle: 'br', x: shape.x + shape.width + 4, y: shape.y + shape.height + 4 },
    { handle: 'tc', x: shape.x + shape.width / 2, y: shape.y - 4 },
    { handle: 'bc', x: shape.x + shape.width / 2, y: shape.y + shape.height + 4 },
  ];
  for (const corner of frameCorners) {
    const hit = harness.selection.getHandleAt(corner.x, corner.y);
    assert.ok(hit, `${corner.handle} handle must be grabbable at its drawn center`);
    assert.equal(hit!.handle, corner.handle);
  }
  const rotateHit = harness.selection.getHandleAt(shape.x + shape.width / 2, shape.y - 32);
  assert.equal(rotateHit?.handle, 'rotate', 'rotation handle stays at its drawn position');
});

test('line shapes frame their visual ink bounds, never a degenerate endpoint rect', () => {
  const horizontalLine = {
    id: 'hline', type: 'shape' as const, shapeType: 'line' as const,
    x: 10, y: 100, width: 190, height: 0, strokeWidth: 2, color: '#20242a', opacity: 1, rotation: 0, createdAt: 1,
  };
  const harness = createLassoHarness([horizontalLine as any]);
  harness.selection.selectElement(horizontalLine.id, 'shape');
  // Ink bounds: radius 1 around the endpoints. Frame: ±4. Distinct top/bottom handles.
  const left = 10 - 1 - 4, top = 100 - 1 - 4, bottom = 100 + 1 + 4;
  const topHit = harness.selection.getHandleAt(left, top);
  // The frame is thinner than the 12-unit handle squares, so handles overlap
  // near the middle; probe below the middle-left square for the bottom handle.
  const bottomHit = harness.selection.getHandleAt(left, bottom + 1.5);
  assert.equal(topHit?.handle, 'tl');
  assert.equal(bottomHit?.handle, 'bl', 'horizontal line must expose distinct top/bottom handles');
  // A freeform loop enclosing the line selects exactly one logical element.
  harness.pointer('startSelection', left - 10, top - 10);
  harness.pointer('continueSelection', left + 220, top - 10);
  harness.pointer('continueSelection', left + 220, bottom + 10);
  harness.pointer('continueSelection', left - 10, bottom + 10);
  harness.pointer('finishSelection', left - 10, top - 10);
  assert.deepEqual(
    new Set(harness.selection.getSelectedElements().map(element => element.id)),
    new Set(['hline']),
  );
});

test('freeform lasso retains the drawn boundary; transforms and new selections clear it', () => {
  const harness = createLassoHarness([
    selectionShape('outline-target', 60, 60, 20, 20),
    selectionShape('outline-far', 400, 300, 20, 20),
  ]);
  // Irregular freeform loop (not a rectangle).
  harness.pointer('startSelection', 20, 20);
  harness.pointer('continueSelection', 150, 25);
  harness.pointer('continueSelection', 170, 90);
  harness.pointer('continueSelection', 100, 120);
  harness.pointer('continueSelection', 30, 95);
  harness.pointer('finishSelection', 20, 20);
  assert.deepEqual(
    new Set(harness.selection.getSelectedElements().map(element => element.id)),
    new Set(['outline-target']),
  );
  const outline = harness.selection.getSelectionOutline();
  assert.ok(outline && outline.length >= 5, 'the drawn freeform boundary is retained after selection');
  assert.ok(Math.abs(outline[2].x - 170) < 1e-6 && Math.abs(outline[2].y - 90) < 1e-6,
    'the retained outline matches the drawn polygon, not a bounding square');
  // A move keeps the boundary: the renderer translates it by the live preview
  // delta (currentDragTransform), and the commit bakes that delta into the
  // stored polygon so the next interaction starts from the moved region.
  harness.selection.startDrag(70, 70); // region centre, clear of the resize handles
  harness.selection.dragTo(110, 95);
  const duringPreview = harness.selection.getSelectionOutline();
  const previewTransform = harness.selection.getMovePreviewDelta();
  assert.ok(previewTransform && Math.abs(previewTransform.dx - 40) < 1e-6 && Math.abs(previewTransform.dy - 25) < 1e-6,
    'the move preview exposes its delta for the outline renderer');
  assert.ok(duringPreview && Math.abs(duringPreview[2].x - 170) < 1e-6, 'stored polygon stays canonical during preview');
  harness.selection.finishDrag(110, 95);
  const baked = harness.selection.getSelectionOutline();
  assert.ok(baked && Math.abs(baked[2].x - 210) < 1e-6 && Math.abs(baked[2].y - 115) < 1e-6,
    `commit bakes the move into the retained outline (${JSON.stringify(baked?.[2])})`);
  // Resize invalidates the polygon: the frame takes over. After the baked move
  // the element sits at (100,85,20,20), so its br handle is at (124,109).
  harness.selection.startDrag(124, 109);
  assert.equal(harness.selection.getSelectionOutline(), null, 'resize/rotate invalidates the drawn region');
  harness.selection.finishDrag(154, 139);
  // A rectangle selection must not reuse the freeform visualization.
  (harness.tools as any).state.selectionShape = 'rectangle';
  harness.pointer('startSelection', 300, 250);
  harness.pointer('continueSelection', 500, 400);
  harness.pointer('finishSelection', 500, 400);
  assert.deepEqual(
    new Set(harness.selection.getSelectedElements().map(element => element.id)),
    new Set(['outline-far']),
  );
  assert.equal(harness.selection.getSelectionOutline(), null, 'rectangle mode shows only the transform frame');
  // Clearing the selection clears any boundary.
  harness.selection.selectWithinLoop([[10, 10], [200, 10], [200, 200], [10, 200]].map(([x, y], t) => ({ x, y, pressure: .5, t })), false, [{ x: 5, y: 5, pressure: .5, t: 0 }, { x: 205, y: 205, pressure: .5, t: 1 }, { x: 5, y: 205, pressure: .5, t: 2 }]);
  assert.ok(harness.selection.getSelectionOutline());
  harness.selection.clearSelection();
  assert.equal(harness.selection.getSelectionOutline(), null);
});

test('rectangular lasso selects enclosed content and Shift constrains to a square', () => {
  const harness = createLassoHarness([
    selectionShape('rect-target', 40, 40, 20, 20),
    selectionShape('rect-outside', 400, 300, 20, 20),
  ]);
  (harness.tools as any).state.selectionShape = 'rectangle';
  harness.pointer('startSelection', 10, 10);
  harness.pointer('continueSelection', 90, 90);
  assert.equal(harness.lassoFrames.at(-1)?.length, 5, 'rectangle preview is a closed 4-corner polygon');
  harness.pointer('finishSelection', 90, 90);
  assert.deepEqual(
    new Set(harness.selection.getSelectedElements().map(element => element.id)),
    new Set(['rect-target']),
  );
  // Shift square constraint: 100x30 drag becomes a 100x100 square.
  harness.selection.clearSelection();
  let square: Array<{ x: number; y: number }> = [];
  const original = harness.selection.selectWithinLoop.bind(harness.selection);
  (harness.selection as any).selectWithinLoop = (points: any[], repaint?: boolean) => { square = points; return original(points, repaint); };
  harness.pointer('startSelection', 10, 10, true);
  harness.pointer('continueSelection', 110, 40, true);
  harness.pointer('finishSelection', 110, 40, true);
  (harness.selection as any).selectWithinLoop = original;
  assert.equal(square.length, 5);
  assert.ok(Math.abs((square[2].x - square[0].x) - (square[2].y - square[0].y)) < 1e-6, 'Shift constrains the rectangle to a square');
});

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
  // Corner handles preserve the original aspect ratio (2:1 here).
  assert.ok(Math.abs(shape.height - shape.width * 0.5) < 1e-6, `corner resize preserves aspect ratio (${shape.width}x${shape.height})`);
});

test('side-handle resize keeps free single-axis scaling while corners preserve ratio', () => {
  const shape = selectionShape('side-resize', 20, 20, 80, 40);
  const harness = createLassoHarness([shape]);
  harness.selection.selectElement(shape.id, 'shape');
  // Right-middle handle: free horizontal resize.
  harness.selection.startDrag(shape.x + shape.width + 4, shape.y + shape.height / 2);
  harness.selection.dragTo(shape.x + shape.width + 44, shape.y + shape.height / 2);
  assert.equal(shape.width, 120, 'side handle resizes width freely');
  assert.equal(shape.height, 40, 'side handle must not change height');
  // Bottom-middle handle: free vertical resize.
  harness.selection.startDrag(shape.x + shape.width / 2, shape.y + shape.height + 4);
  harness.selection.dragTo(shape.x + shape.width / 2, shape.y + shape.height + 24);
  assert.equal(shape.height, 60, 'top/bottom handle resizes height freely');
  assert.equal(shape.width, 120, 'top/bottom handle must not change width');
  // Corner handle: ratio locked to the original 80x40 (2:1).
  const ratioWidth = shape.width;
  harness.selection.startDrag(shape.x + shape.width + 4, shape.y + shape.height + 4);
  harness.selection.dragTo(shape.x + shape.width + 44, shape.y + shape.height + 24);
  assert.ok(Math.abs(shape.height - shape.width * 0.5) < 1e-6, 'corner resize preserves the original ratio');
  assert.ok(shape.width > ratioWidth);
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
  // Clip geometry stays canonical during the preview.
  assert.deepEqual(stroke.inkClip?.[0]?.[0]?.[1], [50, 0]);
  assert.equal(harness.selection.finishDrag(224, 124), true);
  assert.deepEqual(stroke.inkClip?.[0]?.[0]?.[1], [100, 0]);
  harness.history.undo();
  assert.deepEqual(stroke.inkClip?.[0]?.[0]?.[1], [50, 0]);
  harness.history.redo();
  assert.deepEqual(stroke.inkClip?.[0]?.[0]?.[1], [100, 0]);
});

function createRulerInputHarness(rulerEnabled: boolean, strokePattern: 'solid' | 'dashed' | 'dotted' = 'solid', stabilization = 0) {
  const ruler = new RulerManager();
  ruler.setEnabled(rulerEnabled);
  const strokes: Stroke[] = [];
  const historyCommands: any[] = [];
  let redraws = 0;
  const toolState = { ...DEFAULT_TOOL_STATE, mode: 'draw' as const, rulerEnabled, stabilization, strokePattern };
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

test('ruler edge samples and the freehand exit remain exact at every stabilization strength', () => {
  for (const setting of [0, 25, 50, 75, 100]) {
    const harness = createRulerInputHarness(true, 'solid', setting);
    const state = harness.ruler.getState(), y = state.center.y - state.height / 2;
    harness.pointer('Down', state.center.x - 120, y - 8);
    harness.pointer('Move', state.center.x - 40, y - 4);
    harness.pointer('Move', state.center.x + 30, y - 48);
    harness.pointer('Up', state.center.x + 30, y - 48);
    assert.deepEqual(harness.strokes[0].points.map(({ x, y }) => ({ x, y })), [
      { x: state.center.x - 120, y }, { x: state.center.x - 40, y },
      { x: state.center.x + 30, y: y - 48 },
    ], `${setting}% cannot smooth a constrained ruler join`);
  }
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
    runFrame: (time: number) => {
      now = time;
      const entry = frames.entries().next().value;
      if (!entry) throw new Error('No laser animation frame pending');
      frames.delete(entry[0]);
      entry[1](time);
    },
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

test('laser accepts a burst without synchronous paints and presents decay once per frame', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager(scheduler.options);
  let paints = 0;
  laser.setRedrawCallback(() => { paints++; });
  for (let i = 0; i < 100; i++) laser.addPoint({ x: i, y: i / 2, pressure: .5, t: i });
  assert.equal(laser.getActiveTrail().length, 100, 'all input samples remain available');
  assert.equal(paints, 0, 'pointer dispatch does not synchronously repaint');
  assert.equal(scheduler.getPendingCount(), 1);
  scheduler.runFrame(16);
  assert.equal(paints, 1);
  assert.equal(laser.getActiveTrail().length, 100);
  scheduler.runFrame(3100);
  assert.equal(paints, 2, 'the last frame removes the expired trail');
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

// ---- Bug 1 unit regressions: unified multi-selection handles, damage bounds, tool switch ----

test('mixed selection with shapes and strokes renders one collective frame and 8 handles only', () => {
  const line: Shape = {
    id: 'group-line', type: 'shape', shapeType: 'line',
    x: 220, y: 180, width: -120, height: -40, color: '#000', strokeWidth: 3, fill: null, rotation: 0, createdAt: 1,
  };
  const rect: Shape = selectionShape('group-rect', 240, 80, 60, 40);
  const stroke: Stroke = {
    id: 'group-stroke', type: 'stroke', tool: 'pen', color: '#000', thickness: 2, opacity: 1, createdAt: 2,
    points: [{ x: 110, y: 90, pressure: 0.5, t: 0 }, { x: 160, y: 120, pressure: 0.5, t: 10 }],
  };
  const harness = createLassoHarness([line, rect], [stroke]);
  const freeformLoop = [
    { x: 80, y: 60 }, { x: 330, y: 60 }, { x: 330, y: 210 }, { x: 80, y: 210 },
  ].map((p, i) => ({ ...p, pressure: 0.5, t: i }));
  harness.selection.selectWithinLoop(freeformLoop, true, freeformLoop);
  assert.equal(harness.selection.getSelectedElements().length, 3);
  const collective = harness.selection.getCollectiveBoundingBox();
  assert.ok(collective && collective.width > 0 && collective.height > 0);
  assert.equal(collective.x, 100);

  let strokeRects = 0;
  let arcs = 0;
  const ctx = new Proxy({
    strokeRect: () => { strokeRects += 1; },
    arc: () => { arcs += 1; },
  }, { get: (target, key) => target[key as keyof typeof target] ?? (() => {}) }) as any;
  harness.selection.renderSelection(ctx);
  assert.equal(strokeRects, 8, 'freeform lasso + mixed selection draws exactly 8 collective handles and 0 per-child handles');
  assert.equal(arcs, 1, 'exactly 1 collective rotation handle');
  assert.equal(harness.selection.getHandleAt(240, 80), null, 'interior child handles do not hijack collective multi-selection');

  harness.selection.selectElement(rect.id, 'shape');
  harness.selection.selectElement(line.id, 'shape', true);
  strokeRects = 0;
  arcs = 0;
  harness.selection.renderSelection(ctx);
  assert.equal(strokeRects, 9, 'non-freeform mixed multi-selection draws 1 collective rect + 8 handles');
  assert.equal(arcs, 1);

  const damage = harness.selection.getSelectionDamage();
  assert.ok(damage);
  const wideLoop = [
    { x: 50, y: 40 }, { x: 420, y: 40 }, { x: 420, y: 250 }, { x: 50, y: 250 },
  ].map((p, i) => ({ ...p, pressure: 0.5, t: i }));
  harness.selection.selectWithinLoop(wideLoop, true, wideLoop);
  const outlineDamage = harness.selection.getSelectionDamage();
  assert.ok(outlineDamage && outlineDamage.left <= 50 && outlineDamage.right >= 420 && outlineDamage.bottom >= 250);
});

test('switching from select to draw/erase/shape clears active selection while preserving hand pan and single text', () => {
  const harness = createInputOwnershipHarness();
  harness.tools.setDrawingTool('pen');
  harness.drawLine(90, 40, 140);
  const strokeId = harness.drawing.getStrokes()[0].id;

  harness.tools.setMode('select');
  harness.selection.selectElement(strokeId, 'stroke');
  assert.equal(harness.selection.getSelectedElements().length, 1);

  // Spacebar temporary hand pan must keep the selection alive.
  harness.tools.setMode('hand');
  assert.equal(harness.selection.getSelectedElements().length, 1);

  harness.tools.setMode('select');
  assert.equal(harness.selection.getSelectedElements().length, 1);

  // Switching to draw must clear the selection and trigger redraw.
  const redrawsBefore = harness.drawing.redrawCount;
  harness.tools.setDrawingTool('pen');
  assert.equal(harness.selection.getSelectedElements().length, 0);
  assert.ok(harness.drawing.redrawCount > redrawsBefore);

  // Switching to eraser or shape also clears selection.
  harness.tools.setMode('select');
  harness.selection.selectElement(strokeId, 'stroke');
  harness.tools.setMode('erase');
  assert.equal(harness.selection.getSelectedElements().length, 0);

  harness.tools.setMode('select');
  harness.selection.selectElement(strokeId, 'stroke');
  harness.tools.setMode('shape');
  assert.equal(harness.selection.getSelectedElements().length, 0);
});

// ---- Bug 2 unit regressions: rotation-invariant & sampling-rate-invariant scribble-to-erase ----

function makeScribbleVariant(kind: 'backForth' | 'zigzag', angleDeg: number, stepsPerLeg = 8): StrokePoint[] {
  const raw: Array<[number, number]> = [];
  if (kind === 'backForth') {
    for (let leg = 0; leg < 6; leg += 1) {
      const x0 = leg % 2 === 0 ? 0 : 110;
      const x1 = leg % 2 === 0 ? 110 : 0;
      for (let s = 0; s < stepsPerLeg; s += 1) {
        const u = s / stepsPerLeg;
        raw.push([x0 + (x1 - x0) * u, leg * 7 + u * 5]);
      }
    }
    raw.push([0, 42]);
  } else {
    for (let leg = 0; leg < 7; leg += 1) {
      const x0 = leg * 20;
      const x1 = (leg + 1) * 20;
      const y0 = leg % 2 === 0 ? 0 : 48;
      const y1 = leg % 2 === 0 ? 48 : 0;
      for (let s = 0; s < stepsPerLeg; s += 1) {
        const u = s / stepsPerLeg;
        raw.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
      }
    }
    raw.push([140, 48]);
  }
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dt = Math.max(4, Math.round(900 / raw.length));
  return raw.map(([x, y], index) => ({
    x: 200 + x * cos - y * sin,
    y: 200 + x * sin + y * cos,
    pressure: 0.5,
    t: index * dt,
  }));
}

test('scribble-to-erase succeeds across 0°, 22.5°, 45°, 90°, 112.5°, 135° and 30–240Hz sampling', () => {
  for (const angle of [0, 22.5, 45, 90, 112.5, 135]) {
    assert.equal(analyzeScribble(makeScribbleVariant('backForth', angle, 8)).isScribble, true, `back-and-forth ${angle}°`);
    assert.equal(analyzeScribble(makeScribbleVariant('zigzag', angle, 8)).isScribble, true, `perpendicular zigzag ${angle}°`);
  }
  for (const stepsPerLeg of [4, 8, 16, 32]) {
    assert.equal(analyzeScribble(makeScribbleVariant('zigzag', 45, stepsPerLeg)).isScribble, true, `45° zigzag at ${stepsPerLeg} steps/leg`);
    assert.equal(analyzeScribble(makeScribbleVariant('backForth', 135, stepsPerLeg)).isScribble, true, `135° back-and-forth at ${stepsPerLeg} steps/leg`);
  }

  // Square 70x70 zigzag.
  const squareZig: StrokePoint[] = [];
  for (let leg = 0; leg < 6; leg += 1) {
    const x0 = (leg / 6) * 70;
    const x1 = ((leg + 1) / 6) * 70;
    const y0 = leg % 2 === 0 ? 0 : 70;
    const y1 = leg % 2 === 0 ? 70 : 0;
    for (let s = 0; s < 6; s += 1) {
      const u = s / 6;
      squareZig.push({ x: 100 + x0 + (x1 - x0) * u, y: 100 + y0 + (y1 - y0) * u, pressure: 0.5, t: squareZig.length * 15 });
    }
  }
  squareZig.push({ x: 170, y: 100, pressure: 0.5, t: squareZig.length * 15 });
  assert.equal(analyzeScribble(squareZig).isScribble, true, 'square 70x70 scribble accepted');

  // Target lookup on rotated multi-stroke word.
  const wordStrokes: Stroke[] = [0, 1, 2, 3].map(i => ({
    id: `word-char-${i}`, type: 'stroke', tool: 'pen', color: '#000', thickness: 2, opacity: 1, createdAt: i,
    points: [
      { x: 220 + i * 32, y: 205, pressure: 0.5, t: 0 },
      { x: 220 + i * 32, y: 245, pressure: 0.5, t: 10 },
    ],
  }));
  const engine = new FakeDrawingEngine(wordStrokes);
  const horizontalZig = makeScribbleVariant('zigzag', 0, 8);
  const targets = findScribbleTargets(horizontalZig, (x, y, r) => engine.findStrokesNearPoint(x, y, r), 6);
  assert.equal(targets.size, 4, 'horizontal zigzag hits every letter stroke in the word');
});

test('scribble-to-erase rejects cursive writing, tight loops, underlines, short strokes, and slow shading', () => {
  // Looped cursive "eeeee" (x-height ~20px, high winding).
  const loops: StrokePoint[] = Array.from({ length: 80 }, (_, i) => {
    const t = i / 14;
    return { x: 40 + t * 24 - Math.cos(t * Math.PI * 2) * 10, y: 60 + Math.sin(t * Math.PI * 2) * 10, pressure: 0.5, t: i * 15 };
  });
  assert.equal(analyzeScribble(loops).isScribble, false, 'cursive eeeee loops rejected');

  // Smooth multi-turn circle/spiral.
  const spiral: StrokePoint[] = Array.from({ length: 70 }, (_, i) => {
    const a = (i / 18) * Math.PI * 2;
    const r = 18 + i * 0.4;
    return { x: 100 + Math.cos(a) * r, y: 100 + Math.sin(a) * r, pressure: 0.5, t: i * 16 };
  });
  assert.equal(analyzeScribble(spiral).isScribble, false, 'spiral rejected');

  // Wavy underline (150x14).
  const wavyUnderline: StrokePoint[] = Array.from({ length: 40 }, (_, i) => ({
    x: 50 + (i / 39) * 150, y: 100 + Math.sin(i * 0.9) * 7, pressure: 0.5, t: i * 20,
  }));
  assert.equal(analyzeScribble(wavyUnderline).isScribble, false, 'wavy underline rejected');

  // Rapid short 'W' stroke (22x18).
  const shortW: StrokePoint[] = [[0, 0], [5, 18], [11, 4], [17, 18], [22, 0], [21, 1], [17, 17], [11, 5], [5, 17], [1, 1]]
    .map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 20 }));
  assert.equal(analyzeScribble(shortW).isScribble, false, 'short W rejected');

  // Slow shading (> 1600 ms).
  const slowShade = makeScribbleVariant('backForth', 0, 8).map((p, i) => ({ ...p, t: i * 50 }));
  assert.equal(analyzeScribble(slowShade).isScribble, false, 'slow shading rejected');
});

// ---- Bug 3 unit regressions: straight lines, rotated rectangles, ovals vs circles, hold-to-snap ----

test('straight-line recognition handles long bowed lines, staircase diagonal jitter, and hold tolerances', () => {
  const bowedLong: StrokePoint[] = Array.from({ length: 50 }, (_, i) => {
    const u = i / 49;
    return { x: 40 + u * 300, y: 100 + Math.sin(Math.PI * u) * 9, pressure: 0.5, t: i * 14 };
  });
  const lineLong = recognizeStraightLine(bowedLong, false);
  assert.equal(lineLong.isLine, true, '300px line with 9px (3%) bow is accepted');

  // Staircase integer-pixel diagonal stroke at 240Hz.
  const staircase: StrokePoint[] = Array.from({ length: 90 }, (_, i) => ({
    x: 50 + Math.round((i / 89) * 160),
    y: 50 + Math.round((i / 89) * 160) + (i % 2),
    pressure: 0.5,
    t: i * 4,
  }));
  assert.equal(recognizeStraightLine(staircase, true).isLine, true, '240Hz staircase diagonal line accepted');
  assert.equal(recognizeStraightLine(staircase, true).snappedAngle !== null, true);

  // Short flick on hold (< 60ms, >= 32px) accepted only with deliberateHold.
  const quickHeldLine: StrokePoint[] = Array.from({ length: 10 }, (_, i) => ({
    x: 10 + i * 4.5, y: 20, pressure: 0.5, t: i * 5,
  }));
  assert.equal(recognizeStraightLine(quickHeldLine, false, 1, { deliberateHold: true }).isLine, true);
});

function roughTriangle(width: number, height: number, pointsPerEdge = 12): StrokePoint[] {
  const corners = [
    [20 + width / 2, 30],
    [20 + width, 30 + height],
    [20, 30 + height],
    [20 + width / 2, 30],
  ];
  const points: StrokePoint[] = [];
  for (let edge = 0; edge < 3; edge += 1) {
    const [startX, startY] = corners[edge];
    const [endX, endY] = corners[edge + 1];
    for (let index = 0; index < pointsPerEdge; index += 1) {
      const progress = index / pointsPerEdge;
      const wobble = Math.sin(progress * Math.PI * 2) * 1.1;
      points.push({
        x: startX + (endX - startX) * progress + wobble,
        y: startY + (endY - startY) * progress - wobble * 0.5,
        pressure: 0.5,
        t: points.length * 28,
      });
    }
  }
  points.push({ x: corners[0][0], y: corners[0][1], pressure: 0.5, t: points.length * 28 });
  return points;
}

test('rough-shape recognition classifies rotated rectangles, triangles, distinguishes circles from tilted ovals, and rejects non-shapes', () => {
  const rotatePts = (pts: StrokePoint[], deg: number): StrokePoint[] => {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return pts.map(p => ({ ...p, x: 200 + (p.x - 100) * cos - (p.y - 80) * sin, y: 200 + (p.x - 100) * sin + (p.y - 80) * cos }));
  };

  // Wide 3:1 rectangle & 30°-tilted rectangle (even with rounded hand corners).
  const wideRect = roughRectangle(210, 70, 12);
  const wideRes = recognizeRoughShape(wideRect, true);
  assert.equal(wideRes.isShape && wideRes.shapeType, 'rectangle');
  assert.equal(wideRes.snapped, false);
  assert.ok(wideRes.width / wideRes.height > 2.5);

  const tiltedRect = rotatePts(roughRectangle(160, 90, 12), 30);
  const tiltedRectRes = recognizeRoughShape(tiltedRect, false);
  assert.equal(tiltedRectRes.isShape && tiltedRectRes.shapeType, 'rectangle');
  assert.ok(Math.abs(tiltedRectRes.rotation - 30) < 6, `expected ~30° rotation, got ${tiltedRectRes.rotation}`);

  // Upright and rotated triangles (0°, 35°, 120°, 180°).
  for (const deg of [0, 35, 120, 180]) {
    const triPts = rotatePts(roughTriangle(120, 105, 12), deg);
    const triRes = recognizeRoughShape(triPts, true, 1, { deliberateHold: true });
    assert.equal(triRes.isShape && triRes.shapeType, 'triangle', `expected triangle at ${deg}°, got ${triRes.shapeType}`);
    assert.ok(triRes.width > 60 && triRes.height > 60);
  }

  // Open 2-segment chevron ('V' / 'L') must never classify as a closed triangle.
  const openChevron = roughTriangle(120, 105, 12).slice(0, 22);
  assert.equal(recognizeRoughShape(openChevron, true, 1, { deliberateHold: true }).isShape, false, 'open chevron rejected');

  // 45°-tilted 2:1 oval MUST remain an oval with snapEqualSides=true, never forced into a circle!
  const tiltedOval = rotatePts(roughEllipse(180, 80, 53), 45);
  const tiltedOvalRes = recognizeRoughShape(tiltedOval, true);
  assert.equal(tiltedOvalRes.isShape && tiltedOvalRes.shapeType, 'ellipse');
  assert.equal(tiltedOvalRes.snapped, false, 'tilted elongated oval must not snap to a circle');
  assert.ok(Math.max(tiltedOvalRes.width, tiltedOvalRes.height) / Math.min(tiltedOvalRes.width, tiltedOvalRes.height) > 1.8);

  // Near-circular loop snaps to circle when snapEqualSides=true.
  const circle = recognizeRoughShape(roughEllipse(104, 96, 49), true);
  assert.equal(circle.isShape && circle.shapeType, 'ellipse');
  assert.equal(circle.snapped, true);
  assert.equal(circle.width, circle.height);
  assert.equal(circle.rotation, 0);

  // JSON round-trip compatibility for rotated oval & triangle.
  const shapeObj: Shape = {
    id: 'oval-1', type: 'shape', shapeType: 'ellipse',
    x: tiltedOvalRes.x, y: tiltedOvalRes.y, width: tiltedOvalRes.width, height: tiltedOvalRes.height,
    rotation: tiltedOvalRes.rotation, color: '#000', strokeWidth: 2, fill: null, opacity: 1, createdAt: 1,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(shapeObj)), shapeObj);
});

test('rotated ovals, rectangles, and triangles work end-to-end across ShapeManager hit-test and SelectionEngine handles/select', () => {
  const layers = new LayerManager();
  const shapeManager = new ShapeManager(layers);
  const oval: Shape = {
    id: 'rot-oval', type: 'shape', shapeType: 'ellipse',
    x: 100, y: 150, width: 220, height: 70, rotation: 45,
    color: '#000', strokeWidth: 3, fill: null, opacity: 1, createdAt: 1,
  };
  const tri: Shape = {
    id: 'tri-1', type: 'shape', shapeType: 'triangle',
    x: 420, y: 120, width: 120, height: 100, rotation: 0,
    color: '#000', strokeWidth: 3, fill: null, opacity: 1, createdAt: 2,
  };
  shapeManager.addShape(oval);
  shapeManager.addShape(tri);
  const cx = oval.x + oval.width / 2;
  const cy = oval.y + oval.height / 2;
  const cos45 = Math.SQRT1_2;

  // Point near rotated major tip (~95px along +45° axis) must hit, while unrotated corner must miss!
  assert.deepEqual(shapeManager.findShapesNearPoint(cx + 95 * cos45, cy + 95 * cos45, 5), ['rot-oval']);
  assert.deepEqual(shapeManager.findShapesNearPoint(cx + 100, cy - 30, 5), [], 'empty region outside rotated oval misses');

  // Triangle center & apex hit; upper-left bounding-box corner outside sloped edge misses!
  assert.deepEqual(shapeManager.findShapesNearPoint(480, 175, 5), ['tri-1']);
  assert.deepEqual(shapeManager.findShapesNearPoint(425, 125, 3), [], 'upper-left AABB corner outside triangle misses');

  const history = new HistoryManager();
  const viewport = new ViewportManager();
  const selection = new SelectionEngine(
    { getStrokes: () => [], redraw() {} } as any,
    shapeManager, history, viewport,
    { getTexts: () => [] } as any,
    { getImages: () => [] } as any,
    layers,
  );
  assert.equal(selection.selectAt(cx + 95 * cos45, cy + 95 * cos45, false), true, 'can select rotated oval tip');
  // Rotated top-right handle lies at local (+114, -39) rotated by +45° -> outside unrotated AABB!
  const hx = cx + 114 * cos45 - (-39) * cos45;
  const hy = cy + 114 * cos45 + (-39) * cos45;
  assert.equal(selection.getHandleAt(hx, hy)?.handle, 'tr', 'rotated handle outside unrotated AABB is still clickable');

  assert.equal(selection.selectAt(425, 125, false), false, 'clicking outside triangle sloped edge clears selection');
  assert.equal(selection.selectAt(480, 175, false), true, 'clicking inside triangle selects it');
  assert.equal(selection.getSelectedElements()[0]?.id, 'tri-1');
});

test('InputManager draw-and-hold-to-snap keeps quick draws freehand and previews/commits on hold across all 5 shape families', () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pendingTimers = new Map<number, () => void>();
  let nextTimerId = 1;
  (globalThis as any).setTimeout = (fn: () => void) => {
    const id = nextTimerId++;
    pendingTimers.set(id, fn);
    return id;
  };
  (globalThis as any).clearTimeout = (id: number) => {
    pendingTimers.delete(id);
  };

  try {
    // Verify out-of-the-box defaults WITHOUT calling setRoughShapeRecognition or setStraightLineRecognition!
    const tools = new ToolManager();
    assert.equal(tools.getState().straightLineRecognition, true, 'straightLineRecognition defaults to true');
    assert.equal(tools.getState().snapRecognizedLines, true, 'snapRecognizedLines defaults to true');
    assert.equal(tools.getState().roughShapeRecognition, true, 'roughShapeRecognition defaults to true');
    assert.equal(tools.getState().snapRecognizedShapes, true, 'snapRecognizedShapes defaults to true');
    tools.setDrawingTool('pen');
    const history = new HistoryManager();
    const shapes: Shape[] = [];
    const previews: Shape[] = [];
    let clearedPreviews = 0;
    const strokes: Stroke[] = [];
    const drawing = {
      getStrokes: () => strokes,
      canEditActiveLayer: () => true,
      addStroke: (s: Stroke) => strokes.push(s),
      removeStroke: (id: string) => { const idx = strokes.findIndex(s => s.id === id); if (idx >= 0) strokes.splice(idx, 1); },
      redraw() {},
      beginLiveStroke() {},
      renderLiveStroke() {},
      renderLiveShapePreview: (s: Shape) => previews.push({ ...s }),
      clearLiveShapePreview: () => { clearedPreviews += 1; },
      commitLiveStroke() {},
      endLiveStroke() {},
      findStrokesNearPoint: () => [],
    };
    const shapeManager = {
      getShapes: () => shapes,
      addShape: (s: Shape) => shapes.push(s),
      removeShape: (id: string) => { const idx = shapes.findIndex(s => s.id === id); return idx >= 0 ? shapes.splice(idx, 1)[0] : undefined; },
      findShapesNearPoint: () => [],
    };
    const viewport = new ViewportManager();
    const layers = new LayerManager();
    const selection = new SelectionEngine(drawing as any, shapeManager as any, history, viewport, { getTexts: () => [] } as any, { getImages: () => [] } as any, layers);
    const input = new InputManager(tools, viewport, drawing as any, new EraserEngine(drawing as any, history), shapeManager as any, selection, history, { getTexts: () => [] } as any, new RulerManager(), new LaserManager());
    const canvas = {
      clientWidth: 800, clientHeight: 800, width: 800, height: 800,
      style: { cursor: '', removeProperty: () => {} },
      addEventListener: () => {}, removeEventListener: () => {},
      setPointerCapture: () => {}, releasePointerCapture: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800 * viewport.getState().scale, height: 800 * viewport.getState().scale }),
      closest: () => null,
    } as unknown as HTMLCanvasElement;
    input.attach(canvas);

    let ts = 0;
    const emit = (phase: 'Down' | 'Move' | 'Up', x: number, y: number, typeOverride?: string) => {
      (input as any)[phase === 'Up' ? 'handlePointerUp' : `handlePointer${phase}`]({
        type: typeOverride ?? `pointer${phase.toLowerCase()}`,
        timeStamp: ++ts, button: 0, buttons: phase === 'Up' ? 0 : 1,
        pointerId: 9, pointerType: 'pen', pressure: 0.5, clientX: x, clientY: y, shiftKey: false, preventDefault: () => {},
      });
    };

    // 1. Quick draw without holding stays untouched freehand ink!
    const quickOval = roughEllipse(160, 90, 40);
    emit('Down', quickOval[0].x, quickOval[0].y);
    for (const p of quickOval.slice(1, -1)) emit('Move', p.x, p.y);
    emit('Up', quickOval[quickOval.length - 1].x, quickOval[quickOval.length - 1].y);
    assert.equal(shapes.length, 0, 'quick draw must stay freehand without spawning a shape');
    assert.equal(strokes.length, 1, 'quick draw commits freehand stroke');
    assert.ok(strokes[0].points.length > 10);

    // 2. Draw + hold (within <=9px jitter) triggers live preview without mutating ShapeManager, drag adjusts, pointerup commits!
    const heldOval = roughEllipse(180, 90, 49);
    emit('Down', heldOval[0].x, heldOval[0].y);
    for (const p of heldOval.slice(1)) emit('Move', p.x, p.y);
    // Micro-jitter within 8px must not kill the hold timer.
    emit('Move', heldOval[heldOval.length - 1].x + 5, heldOval[heldOval.length - 1].y + 4);
    assert.equal(pendingTimers.size, 1, 'one active hold timer queued');
    const [timerId, fireHold] = [...pendingTimers.entries()][0];
    pendingTimers.delete(timerId);
    fireHold();
    assert.equal(previews.length, 1, 'hold fires live shape preview');
    assert.equal(shapes.length, 0, 'ShapeManager untouched until pointerup');
    // Drag outward while held to scale up preview.
    emit('Move', heldOval[heldOval.length - 1].x + 80, heldOval[heldOval.length - 1].y);
    assert.equal(previews.length, 2, 'dragging after hold updates live shape preview');
    assert.ok(previews[1].width > previews[0].width);
    // Release commits adjusted shape with undo/redo!
    emit('Up', heldOval[heldOval.length - 1].x + 80, heldOval[heldOval.length - 1].y);
    assert.equal(shapes.length, 1);
    assert.equal(shapes[0].shapeType, 'ellipse');
    assert.equal(strokes.length, 1, 'held shape does not also leave a raw ink stroke');
    history.undo();
    assert.equal(shapes.length, 0);
    history.redo();
    assert.equal(shapes.length, 1);

    // 3. Draw + hold a straight line, rectangle, and triangle (including with Marker tool and at 800% zoom).
    const runHoldGesture = (pts: StrokePoint[]) => {
      emit('Down', pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) emit('Move', p.x, p.y);
      assert.equal(pendingTimers.size, 1);
      const [id, fn] = [...pendingTimers.entries()][0];
      pendingTimers.delete(id);
      fn();
      emit('Up', pts[pts.length - 1].x, pts[pts.length - 1].y);
    };

    const heldLine = Array.from({ length: 24 }, (_, i) => ({ x: 40 + i * 6, y: 120 + i * 2.5, pressure: 0.5, t: i * 16 }));
    runHoldGesture(heldLine);
    assert.equal(shapes.at(-1)?.shapeType, 'line', 'held line commits Shape with shapeType=line');

    tools.setDrawingTool('marker');
    runHoldGesture(roughRectangle(130, 80, 10));
    assert.equal(shapes.at(-1)?.shapeType, 'rectangle', 'held rectangle with Marker commits Shape with shapeType=rectangle');

    viewport.setZoom(8); // 800% zoom: screen coordinates remain identical while page coordinates are 1/8th
    runHoldGesture(roughTriangle(110, 95, 12));
    assert.equal(shapes.at(-1)?.shapeType, 'triangle', 'held triangle at 800% zoom commits Shape with shapeType=triangle');
    assert.ok((shapes.at(-1)?.width ?? 0) < 25, 'page-space triangle width at 800% zoom is ~13.75 page units');
    viewport.setZoom(1);
    tools.setDrawingTool('pen');

    // 4. pointercancel during hold preview clears cleanly without committing.
    const countBeforeCancel = shapes.length;
    emit('Down', heldOval[0].x, heldOval[0].y);
    for (const p of heldOval.slice(1)) emit('Move', p.x, p.y);
    const [t2, fire2] = [...pendingTimers.entries()][0];
    pendingTimers.delete(t2);
    fire2();
    emit('Up', heldOval[heldOval.length - 1].x, heldOval[heldOval.length - 1].y, 'pointercancel');
    assert.equal(shapes.length, countBeforeCancel, 'pointercancel never commits preview shape');
    assert.ok(clearedPreviews >= 0);

    // 5. Early-tick motionless-hold lockout prevention (Trap #1):
    // Draw a 21 CSS-px line (>= 20px arm threshold, < 24px straight-line min length) so the
    // first hold timer fires and fails, leaving holdSnapTimer === null. Then extend 8 CSS px
    // (<= 14 CSS px anchor radius -> now 29px >= 24px) and hold 100% motionless.
    // A retry timer MUST be scheduled (no permanent lockout) and MUST snap to 'line'!
    const shapesBeforeLockoutTest = shapes.length;
    emit('Down', 200, 200);
    for (let i = 1; i <= 7; i++) emit('Move', 200 + i * 3, 200); // 21px -> arms timer
    assert.equal(pendingTimers.size, 1, 'timer armed at >= 20 CSS px');
    const [shortId, fireShort] = [...pendingTimers.entries()][0];
    pendingTimers.delete(shortId);
    fireShort(); // fails because 21px < 24px min line length; holdSnapTimer is now null!
    assert.equal(shapes.length, shapesBeforeLockoutTest);
    // Extend 8px (<= 14px anchor radius) to reach 29px and go 100% motionless:
    emit('Move', 225, 200);
    emit('Move', 229, 200);
    assert.equal(pendingTimers.size, 1, 'moving inside <=14px anchor after a failed tick MUST re-arm hold timer (no motionless lockout)');
    const [retryId, fireRetry] = [...pendingTimers.entries()][0];
    pendingTimers.delete(retryId);
    fireRetry();
    emit('Up', 229, 200);
    assert.equal(shapes.length, shapesBeforeLockoutTest + 1, 're-armed motionless hold commits snapped line');
    assert.equal(shapes.at(-1)?.shapeType, 'line');

    // 6. Right triangle & apex-down equilateral triangle with 240Hz hold tremor (Trap #7).
    const rightTriVerts = [[100, 100], [100, 220], [240, 220]];
    const rightTriPts: StrokePoint[] = [];
    for (let e = 0; e < 3; e++) {
      const a = rightTriVerts[e], b = rightTriVerts[(e + 1) % 3];
      for (let i = 0; i < 16; i++) {
        const u = i / 16;
        rightTriPts.push({ x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, pressure: 0.4, t: rightTriPts.length * 8 });
      }
    }
    rightTriPts.push({ x: 100, y: 106, pressure: 0.4, t: rightTriPts.length * 8 });
    for (let j = 0; j < 40; j++) {
      rightTriPts.push({ x: 100 + Math.sin(j * 1.7) * 3.5, y: 106 + Math.cos(j * 2.1) * 3.5, pressure: 0.4, t: rightTriPts[rightTriPts.length - 1].t + 4 });
    }
    const rightTriRes = recognizeRoughShape(rightTriPts, true, 1, { deliberateHold: true });
    assert.equal(rightTriRes.isShape && rightTriRes.shapeType, 'triangle', 'right triangle with overshoot + hold tremor recognized');

    input.detach();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
