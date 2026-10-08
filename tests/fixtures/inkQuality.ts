import type { StrokePoint } from '../../src/components/notebook/engine/drawingTypes.ts';

export const INK_ZOOMS = [.25, .5, .75, 1, 1.5, 2.28, 3] as const;
export const INK_STABILIZATION = [0, 25, 50, 75, 100] as const;
export const INK_CASES = ['straight', 'circle', 'zigzag', 'word', 'dot', 'flick', 'pressure', 'irregular', 'sparse', 'reversal'] as const;
export type InkCase = typeof INK_CASES[number];

function vertices(points: number[][], u: number): [number, number] {
  const f = u * (points.length - 1), i = Math.min(points.length - 2, Math.floor(f));
  return [points[i][0] + (points[i + 1][0] - points[i][0]) * (f - i), points[i][1] + (points[i + 1][1] - points[i][1]) * (f - i)];
}

/** Synthetic trajectories, never presented as captured physical handwriting. */
export function inkFixture(kind: InkCase, hz = 120, zoom = 1, noise = true, duration = 1000) {
  const count = kind === 'dot' ? 1 : kind === 'flick' ? 4 : kind === 'sparse' ? 17 : Math.round(hz * duration / 1000) + 1;
  const ideal: StrokePoint[] = [], raw: StrokePoint[] = [];
  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 0 : i / (count - 1);
    let xy: [number, number];
    if (kind === 'circle' || kind === 'sparse') xy = [75 + 40 * Math.cos(u * Math.PI * 2), 65 + 40 * Math.sin(u * Math.PI * 2)];
    else if (kind === 'zigzag') xy = vertices([[20, 90], [50, 30], [80, 90], [110, 30], [140, 90]], u);
    else if (kind === 'reversal') xy = vertices([[20, 60], [100, 60], [35, 60], [150, 65]], u);
    else if (kind === 'word') xy = [20 + 170 * u + 9 * Math.sin(12 * Math.PI * u), 65 + 18 * Math.sin(12 * Math.PI * u)];
    else if (kind === 'flick') xy = [30 + 6 * u, 60 - 12 * u];
    else if (kind === 'dot') xy = [40, 60];
    else xy = [20 + 170 * u, 60 + (kind === 'pressure' ? 12 * Math.sin(u * Math.PI * 2) : 0)];
    const t = u * duration + (kind === 'irregular' && i > 0 && i < count - 1 ? Math.sin(i * .9) * duration / count * .4 : 0);
    const point = { x: xy[0] / zoom, y: xy[1] / zoom, pressure: kind === 'pressure' ? .1 + .8 * u : .5, t };
    ideal.push(point);
    const jitter = noise && i > 0 && i < count - 1 && !['dot', 'flick', 'sparse'].includes(kind) ? .8 * Math.sin(i * 2.37) : 0;
    raw.push({ ...point, y: point.y + jitter / zoom });
  }
  return { kind, hz, zoom, ideal, raw };
}

export function qualityMetrics(ideal: readonly StrokePoint[], output: readonly StrokePoint[], zoom = 1) {
  const distance = (p: StrokePoint, a: StrokePoint, b: StrokePoint) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy) * zoom;
  };
  const deviation = (p: StrokePoint) => {
    if (ideal.length === 1) return Math.hypot(p.x - ideal[0].x, p.y - ideal[0].y) * zoom;
    let nearest = Infinity;
    for (let i = 1; i < ideal.length; i++) nearest = Math.min(nearest, distance(p, ideal[i - 1], ideal[i]));
    return nearest;
  };
  const deviations = output.map(deviation);
  // Integrate along the visible polyline rather than rewarding sample count.
  let weightedError = 0, totalLength = 0;
  for (let i = 1; i < output.length; i++) {
    const a = output[i - 1], b = output[i], length = Math.hypot(b.x - a.x, b.y - a.y) * zoom;
    const steps = Math.max(1, Math.ceil(length / .25));
    for (let j = 0; j < steps; j++) {
      const u = (j + .5) / steps;
      const error = deviation({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, pressure: 0, t: 0 });
      weightedError += error * error * length / steps;
    }
    totalLength += length;
  }
  const end = output.at(-1)!, tip = ideal.at(-1)!;
  const turns: number[] = [];
  for (let i = 1; i < output.length - 1; i++) {
    const a = output[i - 1], b = output[i], c = output[i + 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-8 && Math.hypot(c.x - b.x, c.y - b.y) > 1e-8)
      turns.push(Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y))));
  }
  return { rmsDeviationPx: Math.sqrt(deviations.reduce((sum, d) => sum + d * d, 0) / deviations.length), maxDeviationPx: Math.max(...deviations),
    pathRmsDeviationPx: totalLength ? Math.sqrt(weightedError / totalLength) : deviations[0],
    endpointPx: Math.hypot(end.x - tip.x, end.y - tip.y) * zoom, maxTurnRadians: Math.max(0, ...turns), points: output.length };
}

/** Designed lowercase paths, not recorded handwriting or a recognition result.
 * Separate dots/crossbars, loops, cusps and hooks exercise small letter detail. */
export function handwritingLetters(zoom = 1, noise = true) {
  const line = (a: number[], b: number[]) => [...a, ...a, ...b, ...b];
  const letters: Record<string, number[][][]> = {
    i: [[line([4, 11], [4, 32])], [[4, 3]]],
    l: [[[5, 32, -1, 20, 12, -7, 10, 5], [10, 5, 5, 20, 1, 32, 15, 31]]],
    t: [[[8, 2, 8, 10, 4, 32, 12, 31]], [line([1, 13], [17, 13])]],
    m: [[[0, 31, 0, 28, 0, 14, 0, 13], [0, 13, 10, 3, 10, 18, 10, 31], [10, 31, 10, 5, 20, 7, 20, 19], [20, 19, 20, 23, 20, 28, 20, 31]]],
    n: [[[0, 31, 0, 27, 0, 17, 0, 13], [0, 13, 14, 3, 16, 16, 16, 31]]],
    e: [[[0, 22, 19, 21, 16, 10, 9, 12], [9, 12, -5, 15, -1, 37, 18, 29]]],
    a: [[[16, 15, 0, 2, -6, 35, 9, 32], [9, 32, 20, 30, 15, 16, 16, 13], [16, 13, 16, 20, 16, 29, 21, 32]]],
    s: [[[18, 14, 6, 5, -3, 18, 8, 21], [8, 21, 24, 24, 14, 37, 0, 30]]],
    k: [[line([2, 2], [2, 32])], [line([18, 12], [2, 24]), line([2, 24], [20, 32])]],
  };
  return Object.entries(letters).flatMap(([letter, paths], index) => paths.map(segments => {
    const points: StrokePoint[] = [];
    for (const s of segments) {
      const steps = s.length === 2 ? 0 : 30;
      for (let j = 0; j <= steps; j++) {
        if (points.length && j === 0) continue;
        const u = steps ? j / steps : 0, v = 1 - u;
        const x = s.length === 2 ? s[0] : v ** 3 * s[0] + 3 * v * v * u * s[2] + 3 * v * u * u * s[4] + u ** 3 * s[6];
        const y = s.length === 2 ? s[1] : v ** 3 * s[1] + 3 * v * v * u * s[3] + 3 * v * u * u * s[5] + u ** 3 * s[7];
        const jitter = noise && j > 0 && j < steps ? .45 * Math.sin(points.length * 2.37) : 0;
        points.push({ x: (20 + index * 19 + x * .7) / zoom, y: (30 + y + jitter) / zoom, pressure: .5, t: points.length * 1000 / 120 });
      }
    }
    return { letter, points };
  }));
}
