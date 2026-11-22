import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  createEmptyDrawingData,
  isLinearShapeType,
  type DrawingData,
  type Shape,
  type ShapeType,
  type StrokePoint,
} from '../src/components/notebook/engine/drawingTypes.ts';
import { recognizeArrowGesture, recognizeStraightLine } from '../src/components/notebook/engine/straightLineGesture.ts';
import { recognizeRoughShape } from '../src/components/notebook/engine/roughShapeGesture.ts';
import { buildLineStyleGeometry, lineStyleHit } from '../src/components/notebook/engine/lineStyleGeometry.ts';
import { constrainShapeDrag } from '../src/components/notebook/engine/shapeGeometry.ts';
import { getShapePolygonVertices, hitTestPolygonShape } from '../src/components/notebook/engine/shapePolygonGeometry.ts';
import { ShapeManager } from '../src/components/notebook/engine/ShapeManager.ts';
import { ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';
import { LayerManager } from '../src/components/notebook/engine/LayerManager.ts';
import { drawPdfShape } from '../src/services/pdf/drawPdfShape.ts';

function toStroke(coords: ReadonlyArray<[number, number]>, dt = 18): StrokePoint[] {
  return coords.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * dt }));
}

function polygonStroke(
  vertices: ReadonlyArray<[number, number]>,
  stepsPerEdge = 10,
  wobbleAmp = 0.8,
  closeLoop = true,
): StrokePoint[] {
  const coords: Array<[number, number]> = [];
  for (let e = 0; e < vertices.length; e += 1) {
    const [x0, y0] = vertices[e];
    const [x1, y1] = vertices[(e + 1) % vertices.length];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    for (let s = 0; s < stepsPerEdge; s += 1) {
      const u = s / stepsPerEdge;
      const wobble = Math.sin(u * Math.PI * 2) * wobbleAmp;
      coords.push([x0 + dx * u + nx * wobble, y0 + dy * u + ny * wobble]);
    }
  }
  if (closeLoop) coords.push(vertices[0]);
  return toStroke(coords, 22);
}

function regularPolygonVerts(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  sides: number,
  startAngle = -Math.PI / 2,
): Array<[number, number]> {
  return Array.from({ length: sides }, (_, i) => {
    const a = startAngle + (i * 2 * Math.PI) / sides;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });
}

function starVerts(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  innerRatio = 0.40,
  startAngle = -Math.PI / 2,
): Array<[number, number]> {
  return Array.from({ length: 10 }, (_, i) => {
    const a = startAngle + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 1 : innerRatio;
    return [cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r];
  });
}

function ellipseStroke(cx: number, cy: number, rx: number, ry: number, rotDeg = 0, pointCount = 49): StrokePoint[] {
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const coords: Array<[number, number]> = Array.from({ length: pointCount }, (_, i) => {
    const a = (i / (pointCount - 1)) * Math.PI * 2;
    const wobble = 1 + Math.sin(a * 5) * 0.03 + Math.cos(a * 3) * 0.015;
    const lx = Math.cos(a) * rx * wobble;
    const ly = Math.sin(a) * ry * wobble;
    return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
  });
  return toStroke(coords, 24);
}

test('recognizeArrowGesture recognizes V-head and checkmark single-stroke arrows and snaps angles cleanly', () => {
  // 1. V-head returning through tip (near horizontal -> snaps to 0°)
  const vHeadCoords: Array<[number, number]> = [];
  for (let i = 0; i <= 12; i += 1) vHeadCoords.push([20 + i * 12, 100 + i * 0.4]);
  vHeadCoords.push([152, 90], [140, 82], [152, 91], [164, 104.8], [152, 114], [140, 124]);
  const vRes = recognizeArrowGesture(toStroke(vHeadCoords, 20), true, 1, { deliberateHold: true });
  assert.equal(vRes.isArrow, true);
  assert.equal(vRes.shapeType, 'arrow');
  assert.ok(vRes.points !== null);
  assert.equal(vRes.snappedAngle, 0);
  assert.ok(Math.abs(vRes.points![1].y - vRes.points![0].y) < 1e-6);

  // 2. Single-barb checkmark arrow (———>) diagonal ~45°
  const checkCoords: Array<[number, number]> = [];
  for (let i = 0; i <= 12; i += 1) checkCoords.push([50 + i * 10, 50 + i * 10]);
  checkCoords.push([162, 146], [154, 134], [146, 124]);
  const checkRes = recognizeArrowGesture(toStroke(checkCoords, 18), true, 1, { deliberateHold: true });
  assert.equal(checkRes.isArrow, true);
  assert.equal(checkRes.shapeType, 'arrow');
  assert.ok(Math.abs((checkRes.snappedAngle ?? 0) - Math.PI / 4) < 1e-6);

  // 3. Cross-over triangular V-head (tip -> barb1 -> barb2) with 240Hz hold jitter
  const crossCoords: Array<[number, number]> = [];
  for (let i = 0; i <= 12; i += 1) crossCoords.push([40 + i * 10, 200]);
  crossCoords.push([148, 186], [136, 178], [136, 198], [136, 222]);
  for (let j = 0; j < 8; j += 1) {
    crossCoords.push([136 + Math.cos(j) * 2.5, 222 + Math.sin(j) * 2.5]);
  }
  const crossRes = recognizeArrowGesture(toStroke(crossCoords, 12), false, 1, { deliberateHold: true });
  assert.equal(crossRes.isArrow, true);

  // 4. Zoom invariance (400% zoom -> page coordinates scaled by 1/4)
  const zoomed = toStroke(checkCoords, 18).map(p => ({ ...p, x: p.x / 4, y: p.y / 4 }));
  const zoomedRes = recognizeArrowGesture(zoomed, true, 4, { deliberateHold: true });
  assert.equal(zoomedRes.isArrow, true);
  assert.ok(Math.abs(zoomedRes.length - checkRes.length / 4) < 1e-4);

  // 5. Rejects plain lines, closed shapes, and wavy cursive strokes
  const plainLine = toStroke(Array.from({ length: 14 }, (_, i) => [10 + i * 12, 40]));
  assert.equal(recognizeStraightLine(plainLine, true, 1, { deliberateHold: true }).isLine, true);
  assert.equal(recognizeArrowGesture(plainLine, true, 1, { deliberateHold: true }).isArrow, false);

  const closedLoop = polygonStroke([[0, 0], [120, 0], [60, 100]], 10, 0, true);
  assert.equal(recognizeArrowGesture(closedLoop, true, 1, { deliberateHold: true }).isArrow, false);

  const cursive = toStroke(Array.from({ length: 40 }, (_, i) => {
    const u = i / 39;
    return [20 + u * 140, 100 + Math.sin(u * Math.PI * 5) * 22];
  }));
  assert.equal(recognizeArrowGesture(cursive, true, 1, { deliberateHold: true }).isArrow, false);
});

test('recognizeRoughShape classifies all expanded note-taking shapes and rejects cursive strokes', () => {
  // Wide rectangle (non-square) vs Square (equal-sided)
  const wideRect = recognizeRoughShape(polygonStroke([[20, 20], [240, 20], [240, 130], [20, 130]], 12, 0.9), true, 1, { deliberateHold: true });
  assert.equal(wideRect.isShape && wideRect.shapeType, 'rectangle');
  assert.equal(wideRect.snapped, false);
  assert.ok(wideRect.width > wideRect.height * 1.8);

  const square = recognizeRoughShape(polygonStroke([[40, 40], [155, 40], [155, 155], [40, 155]], 10, 0.7), true, 1, { deliberateHold: true });
  assert.equal(square.isShape && square.shapeType, 'rectangle');
  assert.equal(square.snapped, true);
  assert.equal(square.width, square.height);

  // Diamond (equal-sided and elongated)
  const diamondPts = polygonStroke(regularPolygonVerts(200, 200, 62, 62, 4, -Math.PI / 2), 10, 0.9);
  const diamond = recognizeRoughShape(diamondPts, true, 1, { deliberateHold: true });
  assert.equal(diamond.isShape && diamond.shapeType, 'diamond');
  assert.equal(diamond.rotation, 0);
  assert.equal(diamond.snapped, true);
  assert.equal(diamond.width, diamond.height);

  const tallDiamondPts = polygonStroke(regularPolygonVerts(200, 200, 50, 90, 4, -Math.PI / 2), 10, 0.9);
  const tallDiamond = recognizeRoughShape(tallDiamondPts, true, 1, { deliberateHold: true });
  assert.equal(tallDiamond.isShape && tallDiamond.shapeType, 'diamond');
  assert.equal(tallDiamond.snapped, false);
  assert.ok(tallDiamond.height > tallDiamond.width * 1.5);

  // 5-Point Star (upright and rotated)
  const starPts = polygonStroke(starVerts(200, 200, 75, 75, 0.40), 6, 0.8);
  const star = recognizeRoughShape(starPts, true, 1, { deliberateHold: true });
  assert.equal(star.isShape && star.shapeType, 'star');
  assert.equal(star.rotation, 0);
  assert.equal(star.snapped, true);
  assert.equal(star.width, star.height);

  const rotStarPts = polygonStroke(starVerts(200, 200, 75, 75, 0.40, -Math.PI / 2 + 0.32), 6, 0.7);
  const rotStar = recognizeRoughShape(rotStarPts, true, 1, { deliberateHold: true });
  assert.equal(rotStar.isShape && rotStar.shapeType, 'star');

  // Pentagon (upright and slightly imperfect)
  const pentPts = polygonStroke(regularPolygonVerts(200, 200, 70, 70, 5, -Math.PI / 2), 10, 1.0);
  const pentagon = recognizeRoughShape(pentPts, true, 1, { deliberateHold: true });
  assert.equal(pentagon.isShape && pentagon.shapeType, 'pentagon');
  assert.equal(pentagon.rotation, 0);
  assert.equal(pentagon.snapped, true);
  assert.equal(pentagon.width, pentagon.height);

  // Hexagon (upright and flat-top 30° rotated)
  const hexPts = polygonStroke(regularPolygonVerts(200, 200, 72, 72, 6, -Math.PI / 2), 9, 0.9);
  const hexagon = recognizeRoughShape(hexPts, true, 1, { deliberateHold: true });
  assert.equal(hexagon.isShape && hexagon.shapeType, 'hexagon');
  assert.equal(hexagon.rotation, 0);
  assert.equal(hexagon.snapped, true);
  assert.equal(hexagon.width, hexagon.height);

  const flatHexPts = polygonStroke(regularPolygonVerts(200, 200, 72, 72, 6, -Math.PI / 2 + Math.PI / 6), 9, 0.8);
  const flatHex = recognizeRoughShape(flatHexPts, true, 1, { deliberateHold: true });
  assert.equal(flatHex.isShape && flatHex.shapeType, 'hexagon');
  assert.ok(Math.abs(Math.abs(flatHex.rotation) - 30) < 2);

  // Triangle, Circle, Oval
  const tri = recognizeRoughShape(polygonStroke([[160, 40], [220, 150], [100, 150]], 11, 0.8), false, 1, { deliberateHold: true });
  assert.equal(tri.isShape && tri.shapeType, 'triangle');

  const circle = recognizeRoughShape(ellipseStroke(160, 160, 52, 50), true, 1, { deliberateHold: true });
  assert.equal(circle.isShape && circle.shapeType, 'ellipse');
  assert.equal(circle.isCircle, true);
  assert.equal(circle.snapped, true);

  const oval = recognizeRoughShape(ellipseStroke(160, 160, 90, 48, 25), true, 1, { deliberateHold: true });
  assert.equal(oval.isShape && oval.shapeType, 'ellipse');
  assert.equal(oval.isCircle, false);
  assert.equal(oval.snapped, false);

  // Slightly polygonal / wobbly circle must NEVER classify as hexagon or pentagon!
  const wobblyCircle = recognizeRoughShape(ellipseStroke(160, 160, 60, 58, 0, 32), true, 1, { deliberateHold: true });
  assert.equal(wobblyCircle.isShape && wobblyCircle.shapeType, 'ellipse');

  // Cursive wave non-snap rejection
  const cursive = toStroke(Array.from({ length: 42 }, (_, i) => {
    const u = i / 41;
    return [40 + u * 130, 180 + Math.sin(u * Math.PI * 4) * 20];
  }));
  assert.equal(recognizeRoughShape(cursive, true, 1, { deliberateHold: true }).isShape, false);
});

test('lineStyleGeometry and constrainShapeDrag support arrow and double-arrow across styles and short lengths', () => {
  assert.equal(isLinearShapeType('line'), true);
  assert.equal(isLinearShapeType('arrow'), true);
  assert.equal(isLinearShapeType('double-arrow'), true);
  assert.equal(isLinearShapeType('pentagon'), false);

  const drag = constrainShapeDrag('double-arrow', { x: 10, y: 20 }, { x: 110, y: 32 }, true);
  assert.equal(drag.x, 10);
  assert.equal(drag.y, 20);
  assert.ok(Math.abs(drag.height) < 1e-6);
  assert.ok(drag.width > 100);

  const arrow: Shape = {
    id: 'a1', type: 'shape', shapeType: 'arrow', x: 0, y: 0, width: 120, height: 0,
    color: '#111111', strokeWidth: 2, fill: null, rotation: 0, createdAt: 1,
  };
  const doubleArrow: Shape = {
    id: 'da1', type: 'shape', shapeType: 'double-arrow', lineStyle: 'dashed',
    x: 20, y: 40, width: 160, height: 40, color: '#111111', strokeWidth: 2, fill: null, rotation: 25, createdAt: 1,
  };
  const arrowGeom = buildLineStyleGeometry(arrow);
  const dblGeom = buildLineStyleGeometry(doubleArrow);
  // Single arrow has 1 shaft + 2 end barbs = 3 paths; double-arrow adds 2 start barbs.
  assert.equal(arrowGeom.paths.length, 3);
  assert.ok(dblGeom.paths.length >= 6);
  for (const p of dblGeom.paths.flat()) {
    assert.ok(p.x >= dblGeom.bounds.x && p.x <= dblGeom.bounds.x + dblGeom.bounds.width);
    assert.ok(p.y >= dblGeom.bounds.y && p.y <= dblGeom.bounds.y + dblGeom.bounds.height);
    assert.equal(lineStyleHit(doubleArrow, p, 0.5), true);
  }

  // Short line clamps barb cleanly in [6, 15]
  const shortArrow: Shape = { ...arrow, width: 20, height: 0 };
  const shortGeom = buildLineStyleGeometry(shortArrow);
  const barbTip = shortGeom.paths[1][1];
  const barbLen = Math.hypot(20 - barbTip.x, barbTip.y);
  assert.ok(Math.abs(barbLen - 7) < 1e-6, `expected clamped barb 20*0.35=7, got ${barbLen}`);
});

test('ShapeManager hit-testing handles rotated diamond, star, pentagon, hexagon, and double-arrow accurately', () => {
  const viewport = new ViewportManager();
  const layers = new LayerManager();
  const sm = new ShapeManager(viewport, layers);

  const diamond: Shape = {
    id: 'dia', type: 'shape', shapeType: 'diamond', x: 100, y: 100, width: 120, height: 80,
    color: '#000', strokeWidth: 2, fill: null, rotation: 0, createdAt: 1,
  };
  const star: Shape = {
    id: 'star', type: 'shape', shapeType: 'star', x: 300, y: 100, width: 100, height: 100,
    color: '#000', strokeWidth: 2, fill: null, rotation: 36, createdAt: 2,
  };
  const pentagon: Shape = {
    id: 'pent', type: 'shape', shapeType: 'pentagon', x: 500, y: 100, width: 100, height: 100,
    color: '#000', strokeWidth: 2, fill: null, rotation: 18, createdAt: 3,
  };
  const hexagon: Shape = {
    id: 'hex', type: 'shape', shapeType: 'hexagon', x: 100, y: 300, width: 100, height: 100,
    color: '#000', strokeWidth: 2, fill: null, rotation: 30, createdAt: 4,
  };
  const doubleArrow: Shape = {
    id: 'dbl', type: 'shape', shapeType: 'double-arrow', x: 320, y: 340, width: 140, height: 0,
    color: '#000', strokeWidth: 3, fill: null, rotation: 0, createdAt: 5,
  };
  for (const s of [diamond, star, pentagon, hexagon, doubleArrow]) sm.addShape(s);

  // Diamond: center hits, AABB corner outside diagonal edge misses
  assert.deepEqual(sm.findShapesNearPoint(160, 140, 4), ['dia']);
  assert.deepEqual(sm.findShapesNearPoint(104, 104, 2), []);

  // Star (center 350,150 rotated +36°): top tip rotated +36° -> angle -54°, radius 50; outer notch at angle -18° (radius 20 vs AABB radius 46) misses!
  const starTipX = 350 + Math.cos((-54 * Math.PI) / 180) * 48;
  const starTipY = 150 + Math.sin((-54 * Math.PI) / 180) * 48;
  const notchX = 350 + Math.cos((-18 * Math.PI) / 180) * 42;
  const notchY = 150 + Math.sin((-18 * Math.PI) / 180) * 42;
  assert.deepEqual(sm.findShapesNearPoint(350, 150, 4), ['star']);
  assert.deepEqual(sm.findShapesNearPoint(starTipX, starTipY, 4), ['star']);
  assert.deepEqual(sm.findShapesNearPoint(notchX, notchY, 2), []);

  // Pentagon & Hexagon: center hits, far corner outside circumcircle misses
  assert.deepEqual(sm.findShapesNearPoint(550, 150, 4), ['pent']);
  assert.deepEqual(sm.findShapesNearPoint(501, 101, 1), []);
  assert.deepEqual(sm.findShapesNearPoint(150, 350, 4), ['hex']);
  assert.deepEqual(sm.findShapesNearPoint(101, 301, 1), []);

  // Double-arrow: shaft, start arrowhead barb, and end arrowhead barb all hit
  assert.deepEqual(sm.findShapesNearPoint(390, 340, 4), ['dbl']);
  assert.deepEqual(sm.findShapesNearPoint(320 + 13, 340 - 7, 3), ['dbl']);
  assert.deepEqual(sm.findShapesNearPoint(460 - 13, 340 + 7, 3), ['dbl']);
  assert.deepEqual(sm.findShapesNearPoint(390, 365, 4), []);

  // getShapePolygonVertices returns null for non-polygons and exact vertex counts for polygons
  assert.equal(getShapePolygonVertices('rectangle', 0, 0, 10, 10), null);
  assert.equal(getShapePolygonVertices('ellipse', 0, 0, 10, 10), null);
  assert.equal(getShapePolygonVertices('double-arrow', 0, 0, 10, 10), null);
  assert.equal(getShapePolygonVertices('pentagon', 0, 0, 100, 100)?.length, 5);
  assert.equal(getShapePolygonVertices('hexagon', 0, 0, 100, 100)?.length, 6);
  assert.equal(getShapePolygonVertices('star', 0, 0, 100, 100)?.length, 10);
  assert.equal(hitTestPolygonShape(diamond, 160, 140, 2), true);
});

test('DrawingData JSON round-trip and drawPdfShape compatibility across all expanded shapes', async () => {
  const shapeTypes: ShapeType[] = [
    'rectangle', 'rounded-rectangle', 'ellipse', 'triangle',
    'diamond', 'star', 'pentagon', 'hexagon', 'arrow', 'double-arrow', 'line',
  ];
  const drawing: DrawingData = createEmptyDrawingData();
  drawing.objects = shapeTypes.map((shapeType, i): Shape => ({
    id: `shape-${shapeType}`,
    type: 'shape',
    shapeType,
    x: 40 + (i % 4) * 120,
    y: 40 + Math.floor(i / 4) * 120,
    width: 80,
    height: isLinearShapeType(shapeType) ? 20 : 80,
    color: '#1e293b',
    strokeWidth: 2,
    fill: i % 2 === 0 && !isLinearShapeType(shapeType) ? '#93c5fd' : null,
    rotation: i * 15,
    opacity: 0.9,
    createdAt: 100 + i,
  }));

  const roundTripped: DrawingData = JSON.parse(JSON.stringify(drawing));
  assert.deepEqual(roundTripped, drawing);

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 500]);
  for (const obj of roundTripped.objects ?? []) {
    if (obj.type === 'shape') drawPdfShape(page, obj, 1, 1);
  }
  const bytes = await pdf.save();
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1);
});

test('ShapeManager.renderShape draws valid paths for all expanded polygon and linear shapes', () => {
  const viewport = new ViewportManager();
  const layers = new LayerManager();
  const sm = new ShapeManager(viewport, layers);
  const calls: string[] = [];
  const mockCtx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    translate: () => {},
    rotate: () => {},
    beginPath: () => calls.push('beginPath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    closePath: () => calls.push('closePath'),
    rect: () => calls.push('rect'),
    roundRect: () => calls.push('roundRect'),
    ellipse: () => calls.push('ellipse'),
    arc: () => calls.push('arc'),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    setLineDash: () => {},
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    lineJoin: 'round',
    lineCap: 'round',
  } as unknown as CanvasRenderingContext2D;

  const base = { type: 'shape' as const, x: 20, y: 30, width: 100, height: 80, color: '#111', strokeWidth: 2, fill: '#eee', rotation: 15, createdAt: 1 };
  for (const shapeType of ['diamond', 'pentagon', 'hexagon', 'star', 'double-arrow'] as const) {
    calls.length = 0;
    sm.renderShape(mockCtx, { ...base, id: shapeType, shapeType });
    assert.ok(calls.includes('beginPath'), `${shapeType} calls beginPath`);
    assert.ok(calls.includes('stroke'), `${shapeType} calls stroke`);
    if (shapeType !== 'double-arrow') {
      assert.ok(calls.includes('closePath'), `${shapeType} closes path`);
      assert.ok(calls.includes('fill'), `${shapeType} fills when fill is set`);
    }
  }
});

test('expanded recognition handles 240Hz stylus hold tremor and browser square/circle/cursive guarantees', () => {
  const withTremor = (pts: StrokePoint[]): StrokePoint[] => {
    const out = [...pts];
    const last = pts[pts.length - 1];
    for (let k = 1; k <= 32; k += 1) {
      const a = k * 0.65;
      const r = 2.0 + (k % 5) * 0.85;
      out.push({ x: last.x + Math.cos(a) * r, y: last.y + Math.sin(a) * r, pressure: 0.4, t: last.t + k * 4 });
    }
    return out;
  };

  // Unclosed + 240Hz tremor diamond, pentagon, hexagon, star
  const diaUnclosed = withTremor(polygonStroke(regularPolygonVerts(200, 200, 65, 65, 4), 10, 1.0, false).slice(0, -3));
  assert.equal(recognizeRoughShape(diaUnclosed, true, 1, { deliberateHold: true }).shapeType, 'diamond');

  const pentTremor = withTremor(polygonStroke(regularPolygonVerts(200, 200, 70, 70, 5), 10, 0.9, true));
  assert.equal(recognizeRoughShape(pentTremor, true, 1, { deliberateHold: true }).shapeType, 'pentagon');

  const hexTremor = withTremor(polygonStroke(regularPolygonVerts(200, 200, 70, 70, 6), 10, 0.9, true));
  assert.equal(recognizeRoughShape(hexTremor, true, 1, { deliberateHold: true }).shapeType, 'hexagon');

  const starTremor = withTremor(polygonStroke(starVerts(200, 200, 78, 78, 0.40), 7, 0.8, true));
  assert.equal(recognizeRoughShape(starTremor, true, 1, { deliberateHold: true }).shapeType, 'star');

  // Arrow with 240Hz tremor at barb tip
  const arrowCoords: Array<[number, number]> = [];
  for (let i = 0; i <= 12; i += 1) arrowCoords.push([20 + i * 12, 100]);
  arrowCoords.push([152, 86], [140, 76]);
  const arrowTremor = withTremor(toStroke(arrowCoords, 16));
  assert.equal(recognizeArrowGesture(arrowTremor, true, 1, { deliberateHold: true }).isArrow, true);

  // Clean 115x115 square (browser Case A guarantee) -> rectangle, snapped 1:1
  const cleanSq = recognizeRoughShape(polygonStroke([[420, 250], [535, 250], [535, 365], [420, 365]], 10, 0, true), true, 1, { deliberateHold: true });
  assert.equal(cleanSq.shapeType, 'rectangle');
  assert.equal(cleanSq.snapped, true);
  assert.equal(cleanSq.width, cleanSq.height);
});

