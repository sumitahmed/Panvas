import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticEraserDescriptor,
  computeCursorTransform,
  dynamicEraserCursor,
  dynamicEraserDescriptor,
  dynamicInkDescriptor,
  isInteractiveUIElement,
  isPointInsideElement,
  resolveDocumentToolCursor,
  resolveToolCursorDescriptor,
  shouldShowPenCursor,
  StylusCursorOverlayController,
  type ToolCursorDescriptor,
} from '../src/components/notebook/documentToolCursor.ts';
import type { ToolState } from '../src/components/notebook/engine/drawingTypes.ts';

function createMockToolState(overrides: Partial<ToolState> = {}): ToolState {
  return {
    mode: 'draw',
    drawingTool: 'pen',
    handwritingToTextEnabled: false,
    handwritingInkColor: '#20242a',
    handwritingInkThickness: 2.4,
    eraserMode: 'pixel',
    shapeTool: 'rectangle',
    color: '#2563eb',
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
    ...overrides,
  };
}

test('Problem B — Distinct tool cursors: pen tool produces authentic fountain pen nib', () => {
  const toolState = createMockToolState({
    mode: 'draw',
    drawingTool: 'pen',
    color: '#ef4444',
  });

  const desc = resolveToolCursorDescriptor(toolState);
  assert.ok(desc !== undefined);
  assert.equal(desc.width, 34);
  assert.equal(desc.height, 34);
  assert.equal(desc.hotspotX, 7);
  assert.equal(desc.hotspotY, 26);
  assert.ok(desc.svg.includes('<svg'));
  assert.ok(desc.svg.includes('#ef4444')); // active ink color
  assert.ok(desc.cssCursor.startsWith('url("data:image/svg+xml'));
  assert.ok(desc.cssCursor.includes('7 26'));

  // Backward compatibility: resolveDocumentToolCursor matches descriptor.cssCursor
  const legacyCursor = resolveDocumentToolCursor(toolState);
  assert.equal(legacyCursor, desc.cssCursor);

  // Caching: subsequent calls return the exact same object reference
  const cachedDesc = resolveToolCursorDescriptor(toolState);
  assert.equal(cachedDesc, desc);
});

test('Problem B — Distinct tool cursors: pencil produces authentic pencil body, wood cone, and lead tip', () => {
  const toolState = createMockToolState({
    mode: 'draw',
    drawingTool: 'pencil',
    color: '#10b981',
  });

  const desc = resolveToolCursorDescriptor(toolState);
  assert.ok(desc !== undefined);
  assert.equal(desc.width, 34);
  assert.equal(desc.height, 34);
  assert.equal(desc.hotspotX, 7);
  assert.equal(desc.hotspotY, 26);
  // Hexagonal shaft #facc15, wood cone #fef08a, active lead tip #10b981
  assert.ok(desc.svg.includes('#facc15'));
  assert.ok(desc.svg.includes('#fef08a'));
  assert.ok(desc.svg.includes('#10b981'));
});

test('Problem B — Distinct tool cursors: marker produces authentic cylindrical casing and bullet tip (does NOT reuse pen)', () => {
  const penDesc = resolveToolCursorDescriptor(createMockToolState({ mode: 'draw', drawingTool: 'pen', color: '#8b5cf6' }))!;
  const markerDesc = resolveToolCursorDescriptor(createMockToolState({ mode: 'draw', drawingTool: 'marker', color: '#8b5cf6' }))!;

  assert.ok(markerDesc !== undefined);
  assert.equal(markerDesc.hotspotX, 7);
  assert.equal(markerDesc.hotspotY, 26);
  assert.ok(markerDesc.svg.includes('#8b5cf6')); // active ink color
  // Casing #27272a, collar #e4e4e7
  assert.ok(markerDesc.svg.includes('#27272a'));
  assert.ok(markerDesc.svg.includes('#e4e4e7'));

  // Distinctness guarantee: Marker must NOT reuse pen cursor SVG
  assert.notEqual(markerDesc.svg, penDesc.svg);
});

test('Problem B — Distinct tool cursors: highlighter produces authentic broad body and angled chisel tip (does NOT reuse pen or marker)', () => {
  const penDesc = resolveToolCursorDescriptor(createMockToolState({ mode: 'draw', drawingTool: 'pen', color: '#ec4899' }))!;
  const markerDesc = resolveToolCursorDescriptor(createMockToolState({ mode: 'draw', drawingTool: 'marker', color: '#ec4899' }))!;
  const hlDesc = resolveToolCursorDescriptor(createMockToolState({ mode: 'draw', drawingTool: 'highlighter', color: '#ec4899' }))!;

  assert.ok(hlDesc !== undefined);
  assert.equal(hlDesc.hotspotX, 7);
  assert.equal(hlDesc.hotspotY, 26);
  assert.ok(hlDesc.svg.includes('#fef08a')); // Yellow highlighter barrel
  assert.ok(hlDesc.svg.includes('#ec4899')); // Active color accent & chisel tip

  // Distinctness guarantee: Highlighter must NOT reuse pen or marker SVG
  assert.notEqual(hlDesc.svg, penDesc.svg);
  assert.notEqual(hlDesc.svg, markerDesc.svg);
});

test('Problem B — Distinct tool cursors: eraser retains authentic dedicated pink angled block eraser (NOT a generic circle)', () => {
  const eraseState = createMockToolState({ mode: 'erase', thickness: 16 });
  const desc = resolveToolCursorDescriptor(eraseState);

  assert.ok(desc !== undefined);
  assert.equal(desc.width, 32);
  assert.equal(desc.height, 32);
  assert.equal(desc.hotspotX, 9);
  assert.equal(desc.hotspotY, 25);
  // Pink body #f6c7d7, dark outline #5d4650, white highlight stripe #fff
  assert.ok(desc.svg.includes('#f6c7d7'));
  assert.ok(desc.svg.includes('#5d4650'));
  assert.ok(desc.svg.includes('#fff'));

  // Critical requirement: Absolutely NO generic dashed circle
  assert.ok(!desc.svg.includes('stroke-dasharray'));
  assert.ok(!desc.svg.includes('<circle'));

  // Tool draw with eraser tool also routes to authentic eraser
  const drawEraserState = createMockToolState({ mode: 'draw', drawingTool: 'eraser' });
  const drawEraserDesc = resolveToolCursorDescriptor(drawEraserState);
  assert.deepEqual(drawEraserDesc, desc);

  // Backward compatibility with dynamicEraserCursor and authenticEraserDescriptor
  assert.equal(dynamicEraserCursor(), desc.cssCursor);
  assert.deepEqual(dynamicEraserDescriptor(), desc);
  assert.deepEqual(authenticEraserDescriptor(), desc);
});

test('Problem B — Distinct tool cursors: laser produces authentic glowing pulse circle', () => {
  const toolState = createMockToolState({
    mode: 'draw',
    drawingTool: 'laser',
    color: '#ef4444',
  });

  const desc = resolveToolCursorDescriptor(toolState);
  assert.ok(desc !== undefined);
  assert.equal(desc.width, 32);
  assert.equal(desc.height, 32);
  assert.equal(desc.hotspotX, 16);
  assert.equal(desc.hotspotY, 16);
  assert.ok(desc.svg.includes('circle'));
  assert.ok(desc.svg.includes('#ef4444'));
  assert.ok(desc.cssCursor.includes('16 16'));
});

test('Problem B — Mutual distinctness: all six tools have unique, non-identical cursor designs', () => {
  const color = '#3b82f6';
  const tools = ['pen', 'pencil', 'marker', 'highlighter', 'eraser', 'laser'] as const;
  const svgs = new Set<string>();

  for (const t of tools) {
    const state = createMockToolState({ mode: t === 'eraser' ? 'erase' : 'draw', drawingTool: t, color });
    const desc = resolveToolCursorDescriptor(state);
    assert.ok(desc, `Tool ${t} must have a descriptor`);
    assert.ok(!svgs.has(desc.svg), `Tool ${t} must have a distinct SVG from all other tools`);
    svgs.add(desc.svg);
  }

  assert.equal(svgs.size, 6);
});

test('Descriptor generation: handwriting recognition color override', () => {
  const toolState = createMockToolState({
    mode: 'draw',
    drawingTool: 'pen',
    color: '#2563eb',
    handwritingToTextEnabled: true,
    handwritingInkColor: '#d97706',
  });

  const desc = resolveToolCursorDescriptor(toolState);
  assert.ok(desc !== undefined);
  assert.ok(desc.svg.includes('#d97706'));
  assert.ok(!desc.svg.includes('#2563eb'));
});

test('Problem A — State parity: non-drawing modes (select, hand, text, shape) return undefined', () => {
  const selectState = createMockToolState({ mode: 'select' });
  assert.equal(resolveToolCursorDescriptor(selectState), undefined);
  assert.equal(resolveDocumentToolCursor(selectState), undefined);

  const handState = createMockToolState({ mode: 'hand' });
  assert.equal(resolveToolCursorDescriptor(handState), undefined);
  assert.equal(resolveDocumentToolCursor(handState), undefined);

  const textState = createMockToolState({ mode: 'text' });
  assert.equal(resolveToolCursorDescriptor(textState), undefined);
  assert.equal(resolveDocumentToolCursor(textState), undefined);

  const shapeState = createMockToolState({ mode: 'shape' });
  assert.equal(resolveToolCursorDescriptor(shapeState), undefined);
  assert.equal(resolveDocumentToolCursor(shapeState), undefined);
});

test('Problem A — UI hover detection: isInteractiveUIElement identifies toolbar controls and buttons', () => {
  // Mock element with closest method
  const mockButton = {
    closest: (selector: string) => (selector.includes('button') ? {} : null),
  } as unknown as Element;

  const mockToolbar = {
    closest: (selector: string) => (selector.includes('panvas-floating-toolbar') ? {} : null),
  } as unknown as Element;

  const mockCanvas = {
    closest: (_selector: string) => null,
  } as unknown as Element;

  assert.equal(isInteractiveUIElement(mockButton), true);
  assert.equal(isInteractiveUIElement(mockToolbar), true);
  assert.equal(isInteractiveUIElement(mockCanvas), false);
  assert.equal(isInteractiveUIElement(null), false);
});

test('Problem A & C — Pointer type differentiation and UI suppression', () => {
  // 1. Stylus pen hovering canvas -> active
  assert.equal(shouldShowPenCursor('pen', true, true, false, false), true);

  // 2. Stylus pen hovering UI toolbar/button -> suppressed (no stuck pen nib over toolbar)
  assert.equal(shouldShowPenCursor('pen', true, true, false, true), false);

  // 3. Stylus pen actively drawing (pointer down) inside or outside container -> active
  assert.equal(shouldShowPenCursor('pen', true, true, true, false), true);
  assert.equal(shouldShowPenCursor('pen', true, false, true, false), true);

  // 4. Stylus pen hovering outside container -> hidden
  assert.equal(shouldShowPenCursor('pen', true, false, false, false), false);

  // 5. Mouse pointer inside container -> suppressed (native CSS cursor handles mouse)
  assert.equal(shouldShowPenCursor('mouse', true, true, false, false), false);
  assert.equal(shouldShowPenCursor('mouse', true, true, true, false), false);

  // 6. Touch pointer inside container -> suppressed (no fake cursor under finger)
  assert.equal(shouldShowPenCursor('touch', true, true, false, false), false);
  assert.equal(shouldShowPenCursor('touch', true, true, true, false), false);

  // 7. Tool has no descriptor (e.g. hand or select mode) -> suppressed
  assert.equal(shouldShowPenCursor('pen', false, true, false, false), false);
  assert.equal(shouldShowPenCursor('pen', false, true, true, false), false);
});

test('Problem C — Cursor transform computation: immediate GPU translate3d with exact hotspot offset', () => {
  // Pen cursor hotspot is (7, 26)
  const penTransform = computeCursorTransform(100, 200, 7, 26);
  assert.equal(penTransform, 'translate3d(93px, 174px, 0)');

  // Eraser cursor hotspot is (9, 25)
  const eraserTransform = computeCursorTransform(350, 450, 9, 25);
  assert.equal(eraserTransform, 'translate3d(341px, 425px, 0)');

  // Subpixel floating point coordinates from high-DPI stylus digitizers
  const subpixelTransform = computeCursorTransform(150.4, 250.6, 7, 26);
  assert.equal(subpixelTransform, 'translate3d(143.4px, 224.6px, 0)');
});

test('Container boundary detection: isPointInsideElement checks client coordinates against bounding rect', () => {
  const mockElement = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 50,
      right: 900,
      bottom: 750,
      width: 800,
      height: 700,
      x: 100,
      y: 50,
      toJSON: () => {},
    }),
  } as unknown as HTMLElement;

  // Inside
  assert.equal(isPointInsideElement(mockElement, 500, 400), true);
  assert.equal(isPointInsideElement(mockElement, 100, 50), true);
  assert.equal(isPointInsideElement(mockElement, 900, 750), true);

  // Outside left
  assert.equal(isPointInsideElement(mockElement, 99, 400), false);
  // Outside right
  assert.equal(isPointInsideElement(mockElement, 901, 400), false);
  // Outside top
  assert.equal(isPointInsideElement(mockElement, 500, 49), false);
  // Outside bottom
  assert.equal(isPointInsideElement(mockElement, 500, 751), false);

  // Null element
  assert.equal(isPointInsideElement(null, 500, 400), false);
});

test('StylusCursorOverlayController: simulates full pen lifecycle, immediate tracking, UI suppression, and native cursor coordination', () => {
  let isVisible = false;
  let transform = '';
  let stylusActiveState = false;
  const visibilityHistory: boolean[] = [];

  const mockContainer = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 100,
      right: 800,
      bottom: 600,
      width: 700,
      height: 500,
      x: 100,
      y: 100,
      toJSON: () => {},
    }),
  } as unknown as HTMLElement;

  const mockCanvasTarget = {
    closest: () => null,
  } as unknown as Element;

  const mockToolbarButtonTarget = {
    closest: (sel: string) => (sel.includes('button') ? {} : null),
  } as unknown as Element;

  let currentToolState = createMockToolState({ mode: 'draw', drawingTool: 'pen' });

  const controller = new StylusCursorOverlayController({
    getDescriptor: () => resolveToolCursorDescriptor(currentToolState),
    getContainer: () => mockContainer,
    onVisibilityChange: v => {
      isVisible = v;
      visibilityHistory.push(v);
    },
    onPositionChange: t => {
      transform = t;
    },
    onStylusActiveChange: active => {
      stylusActiveState = active;
    },
  });

  // Initial state: hidden, native cursor not suppressed
  assert.equal(controller.getIsVisible(), false);
  assert.equal(stylusActiveState, false);

  // 1. Mouse pointer inside container -> ignored/suppressed (mouse uses native CSS cursor)
  controller.handlePointerMove({ pointerType: 'mouse', clientX: 200, clientY: 200 });
  assert.equal(controller.getIsVisible(), false);
  assert.equal(stylusActiveState, false);

  // 2. Touch pointer inside container -> ignored/suppressed (no fake cursor under finger)
  controller.handlePointerMove({ pointerType: 'touch', clientX: 200, clientY: 200 });
  assert.equal(controller.getIsVisible(), false);
  assert.equal(stylusActiveState, false);

  // 3. Pen pointer hovers over canvas -> becomes immediately visible with zero RAF delay
  controller.handlePointerMove({ pointerType: 'pen', clientX: 200, clientY: 200, target: mockCanvasTarget });
  assert.equal(controller.getIsVisible(), true);
  assert.equal(stylusActiveState, true); // notifies to suppress native canvas cursor!
  assert.equal(transform, 'translate3d(193px, 174px, 0)');

  // 4. Pen moves to (250, 300) -> immediately updates transform synchronously (Problem C: zero latency)
  controller.handlePointerMove({ pointerType: 'pen', clientX: 250, clientY: 300, target: mockCanvasTarget });
  assert.equal(transform, 'translate3d(243px, 274px, 0)');

  // 5. Pen hovers over toolbar button -> IMMEDIATELY hides overlay (Problem A: no stuck pen nib over UI)
  controller.handlePointerMove({ pointerType: 'pen', clientX: 250, clientY: 120, target: mockToolbarButtonTarget });
  assert.equal(controller.getIsVisible(), false);
  assert.equal(stylusActiveState, false); // native UI pointer cursor is restored!

  // 6. Pen moves back over canvas -> immediately restores tool cursor
  controller.handlePointerMove({ pointerType: 'pen', clientX: 250, clientY: 300, target: mockCanvasTarget });
  assert.equal(controller.getIsVisible(), true);
  assert.equal(stylusActiveState, true);

  // 7. Pen touches down to draw inside canvas -> isPenDown becomes true
  controller.handlePointerDown({ pointerType: 'pen', clientX: 250, clientY: 300, target: mockCanvasTarget });
  assert.equal(controller.getIsPenDown(), true);
  assert.equal(controller.getIsVisible(), true);

  // 8. Active stroke drags across boundary under pointer capture -> remains visible
  controller.handlePointerMove({ pointerType: 'pen', clientX: 50, clientY: 50 });
  assert.equal(controller.getIsVisible(), true);
  assert.equal(transform, 'translate3d(43px, 24px, 0)');

  // 9. Pen lifts outside container -> isPenDown becomes false and overlay hides
  controller.handlePointerUp({ pointerType: 'pen', clientX: 50, clientY: 50 });
  assert.equal(controller.getIsPenDown(), false);
  assert.equal(controller.getIsVisible(), false);
  assert.equal(stylusActiveState, false);

  // 10. Pen re-enters container -> becomes visible again
  controller.handleContainerPointerEnter({ pointerType: 'pen', clientX: 300, clientY: 400 });
  assert.equal(controller.getIsVisible(), true);
  assert.equal(transform, 'translate3d(293px, 374px, 0)');

  // 11. Switch tool to hand mode while pen is hovering -> immediately hides (Problem A: hand mode parity)
  currentToolState = createMockToolState({ mode: 'hand' });
  controller.syncDescriptor(resolveToolCursorDescriptor(currentToolState));
  assert.equal(controller.getIsVisible(), false);
  assert.equal(stylusActiveState, false);

  // 12. Switch tool to select mode while pen is hovering -> remains hidden (Problem A: select mode parity)
  currentToolState = createMockToolState({ mode: 'select' });
  controller.syncDescriptor(resolveToolCursorDescriptor(currentToolState));
  assert.equal(controller.getIsVisible(), false);
  assert.equal(stylusActiveState, false);

  // 13. Switch tool to eraser mode -> immediately shows authentic eraser
  currentToolState = createMockToolState({ mode: 'erase' });
  controller.syncDescriptor(resolveToolCursorDescriptor(currentToolState));
  controller.handlePointerMove({ pointerType: 'pen', clientX: 300, clientY: 400, target: mockCanvasTarget });
  assert.equal(controller.getIsVisible(), true);
  assert.equal(stylusActiveState, true);
  // Eraser hotspot is (9, 25) -> (300 - 9, 400 - 25) = (291, 375)
  assert.equal(transform, 'translate3d(291px, 375px, 0)');

  controller.destroy();
  assert.equal(controller.getIsVisible(), false);
  assert.equal(stylusActiveState, false);
});
