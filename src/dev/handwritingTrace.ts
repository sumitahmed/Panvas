import type { StrokePoint } from '../components/notebook/engine/drawingTypes.ts';
import type { InkSample } from '../components/notebook/engine/inkSamples.ts';

export interface HandwritingTrace {
  counters: Record<string, number>;
  timings: Record<string, number[]>;
  raw: Array<InkSample & { processingTime: number }>;
  normalized: InkSample[];
  mapped: StrokePoint[];
  stabilized: StrokePoint[];
  committed: StrokePoint[];
  rendered: StrokePoint[];
  /** Transient identity only; removed before publishing. */
  renderedSource?: StrokePoint[];
  frames: Array<{ time: number; phase: 'frame' | 'commit'; points: number; terminal: StrokePoint }>;
  finalEndpointDifference: number;
  outcome: string;
  markers: Array<{ name: string; time: number; details?: Record<string, unknown> }>;
}

let activeTrace: HandwritingTrace | null = null;

function traceEnabled(): boolean {
  return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV
    && typeof window !== 'undefined'
    && (new URLSearchParams(window.location.search).get('handwritingTrace') === '1'
      || window.localStorage.getItem('panvas.handwritingTrace') === '1'));
}

/** Buffered lifecycle markers shared by input and persistence; no console logging. */
export function recordHandwritingTraceMarker(name: string, details?: Record<string, unknown>): void {
  if (!traceEnabled()) return;
  const time = performance.now();
  const target = window as Window & {
    __panvasHandwritingTraceEvents?: Array<{ name: string; time: number; details?: Record<string, unknown> }>;
    __panvasHandwritingTraces?: HandwritingTrace[];
  };
  const event = { name, time, details };
  const events = target.__panvasHandwritingTraceEvents ??= [];
  events.push(event);
  if (events.length > 512) events.splice(0, events.length - 512);
  if (activeTrace) activeTrace.markers.push(event);
  else {
    const traces = target.__panvasHandwritingTraces;
    if (traces?.length) {
      const latest = traces[traces.length - 1];
      (latest.markers ??= []).push(event);
    }
  }
}

export function startHandwritingTrace(): HandwritingTrace | null {
  if (!traceEnabled()) return null;
  activeTrace = { counters: {}, timings: {}, raw: [], normalized: [], mapped: [], stabilized: [], rendered: [], frames: [], committed: [], finalEndpointDifference: 0, outcome: 'active', markers: [] };
  return activeTrace;
}

/** One buffered record per completed/cancelled stroke; no per-event logging or UI overlay. */
export function finishHandwritingTrace(trace: HandwritingTrace | null, outcome: string): void {
  if (!trace) return;
  trace.outcome = outcome;
  delete trace.renderedSource;
  const target = window as Window & { __panvasHandwritingTraces?: HandwritingTrace[] };
  const records = target.__panvasHandwritingTraces ??= [];
  records.push(trace);
  if (records.length > 8) records.shift();
  if (activeTrace === trace) activeTrace = null;
  window.dispatchEvent(new CustomEvent('panvas:handwriting-trace', { detail: trace }));
}
