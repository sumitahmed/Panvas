import type { StrokePoint } from '../../src/components/notebook/engine/drawingTypes.ts';

type XY = [number, number];
const corners = (vertices: XY[]) => (t: number): XY => {
  const f = t * (vertices.length - 1), i = Math.min(vertices.length - 2, Math.floor(f)), a = vertices[i], b = vertices[i + 1];
  return [a[0] + (b[0] - a[0]) * (f - i), a[1] + (b[1] - a[1]) * (f - i)];
};
export const handwritingPaths: Record<string, (t: number) => XY> = {
  straight: t => [t * 100, 0],
  rightAngle: corners([[0,0], [40,0], [40,40]]),
  v: corners([[0,0], [20,40], [40,0]]),
  zigzag: corners([[0,0], [15,25], [30,0], [45,25], [60,0], [75,25], [90,0]]),
  reversal: corners([[0,0], [40,0], [5,0], [50,3]]),
  tightCircle: t => [8 * Math.cos(2*Math.PI*t), 8 * Math.sin(2*Math.PI*t)],
  tightLoop: t => [10*Math.sin(2*Math.PI*t), 16*Math.sin(Math.PI*t)],
  hook: t => [30*t + 12*Math.sin(2*Math.PI*t), 20*(1-Math.cos(Math.PI*t))],
  terminalFlick: corners([[0,0], [5,20], [10,5], [40,-15]]),
  cursiveE: t => [40*t + 12*Math.sin(2*Math.PI*t), 10*Math.sin(2*Math.PI*t)],
  cursiveM: t => [70*t + 4*Math.sin(6*Math.PI*t), -18*Math.sin(3*Math.PI*t)**2],
  cursive: t => [100*t + 10*Math.sin(6*Math.PI*t), 16*Math.sin(6*Math.PI*t)],
};
export function handwritingPath(name: string, hz: number): StrokePoint[] {
  return Array.from({length: hz + 1}, (_,i) => {
    const t = i/hz, [x,y] = handwritingPaths[name](t);
    return {x, y, pressure: .2+.6*t, t: t*1000};
  });
}
export function oldFiltered(points: StrokePoint[], stabilization = 52): StrokePoint[] {
  let prior: StrokePoint;
  return points.map(raw => {
    if (!prior) return prior = {...raw};
    const a = stabilization/100, d = Math.hypot(raw.x-prior.x,raw.y-prior.y);
    const alpha = Math.min(1,1-a+a*(.16+Math.min(.68,d/24)));
    return prior = {x:prior.x+alpha*(raw.x-prior.x),y:prior.y+alpha*(raw.y-prior.y),
      pressure:prior.pressure+(raw.pressure-prior.pressure)*(1-a*.72),t:raw.t};
  });
}
export function pathLength(points: StrokePoint[]): number {
  return points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p.x-points[i].x,p.y-points[i].y),0);
}
export function pathDistance(p: StrokePoint, path: StrokePoint[]): number {
  let best = Infinity;
  for (let i=1;i<path.length;i++) {
    const a=path[i-1],b=path[i],dx=b.x-a.x,dy=b.y-a.y;
    const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy || 1)));
    best=Math.min(best,Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy));
  }
  return best;
}
export function geometryMetrics(raw: StrokePoint[], output: StrokePoint[]) {
  const deviations=raw.map((p,i)=>Math.hypot(p.x-output[i].x,p.y-output[i].y));
  const angle = (a:StrokePoint,b:StrokePoint,c:StrokePoint) => Math.atan2(
    (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x),(b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y));
  let turnError=0;
  for (let i=1;i<raw.length-1;i++) {
    const d=angle(raw[i-1],raw[i],raw[i+1])-angle(output[i-1],output[i],output[i+1]);
    turnError=Math.max(turnError,Math.abs(Math.atan2(Math.sin(d),Math.cos(d))));
  }
  const area=(points:StrokePoint[])=>Math.abs(points.reduce((s,p,i)=>{const q=points[(i+1)%points.length];return s+p.x*q.y-q.x*p.y;},0)/2);
  return {meanDeviation:deviations.reduce((a,b)=>a+b,0)/deviations.length,maxDeviation:Math.max(...deviations),
    endpointError:deviations.at(-1)!,pathLengthRatio:pathLength(output)/pathLength(raw),maxTurnErrorRadians:turnError,
    loopAreaRatio:area(raw)>1e-6?area(output)/area(raw):null};
}
