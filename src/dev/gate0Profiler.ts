type Scalar = string | number | boolean | null;

export interface Gate0Record {
  name: string;
  startedAt: number;
  durationMs?: number;
  counters: Record<string, number>;
  samples: Record<string, number[]>;
  meta: Record<string, Scalar>;
}

export interface Gate0Report {
  enabled: boolean;
  startedAt: number;
  records: Gate0Record[];
  events: Array<{ name: string; at: number; durationMs?: number; meta: Record<string, Scalar> }>;
  resources: Record<string, number>;
  highWater: Record<string, number>;
  dropped: { records: number; events: number; samples: number };
}

const MAX_RECORDS = 256;
const MAX_EVENTS = 1024;
const MAX_SAMPLES_PER_METRIC = 2048;
const STORAGE_KEY = 'panvas.gate0Profiler';
const isDevelopmentBuild = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);

class Gate0Profiler {
  private startedAt = performance.now();
  private records: Gate0Record[] = [];
  private events: Gate0Report['events'] = [];
  private active = new Map<string, Gate0Record>();
  private resources: Record<string, number> = {};
  private highWater: Record<string, number> = {};
  private dropped = { records: 0, events: 0, samples: 0 };

  isEnabled(): boolean {
    if (!isDevelopmentBuild || typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === '1'
      || new URLSearchParams(window.location.search).get('gate0Profile') === '1';
  }

  reset(): void {
    this.startedAt = performance.now();
    this.records = [];
    this.events = [];
    this.active.clear();
    this.resources = {};
    this.highWater = {};
    this.dropped = { records: 0, events: 0, samples: 0 };
  }

  start(name: string, meta: Record<string, Scalar> = {}): Gate0Record | null {
    if (!this.isEnabled()) return null;
    const record: Gate0Record = { name, startedAt: performance.now(), counters: {}, samples: {}, meta: { ...meta } };
    this.active.set(name, record);
    return record;
  }

  getActive(name: string): Gate0Record | null {
    return this.isEnabled() ? this.active.get(name) ?? null : null;
  }

  finish(record: Gate0Record | null, meta: Record<string, Scalar> = {}): void {
    if (!record) return;
    record.durationMs = performance.now() - record.startedAt;
    Object.assign(record.meta, meta);
    if (this.active.get(record.name) === record) this.active.delete(record.name);
    if (this.records.length >= MAX_RECORDS) {
      this.records.shift();
      this.dropped.records += 1;
    }
    this.records.push(record);
  }

  increment(record: Gate0Record | null, metric: string, amount = 1): void {
    if (!record) return;
    record.counters[metric] = (record.counters[metric] ?? 0) + amount;
  }

  sample(record: Gate0Record | null, metric: string, value: number): void {
    if (!record || !Number.isFinite(value)) return;
    const samples = record.samples[metric] ?? (record.samples[metric] = []);
    if (samples.length >= MAX_SAMPLES_PER_METRIC) {
      this.dropped.samples += 1;
      return;
    }
    samples.push(value);
  }

  annotate(record: Gate0Record | null, meta: Record<string, Scalar>): void {
    if (record) Object.assign(record.meta, meta);
  }

  event(name: string, durationMs?: number, meta: Record<string, Scalar> = {}): void {
    if (!this.isEnabled()) return;
    if (this.events.length >= MAX_EVENTS) {
      this.events.shift();
      this.dropped.events += 1;
    }
    this.events.push({ name, at: performance.now(), durationMs, meta: { ...meta } });
  }

  resource(name: string, delta: number): void {
    if (!this.isEnabled()) return;
    this.resources[name] = Math.max(0, (this.resources[name] ?? 0) + delta);
    this.highWater[name] = Math.max(this.highWater[name] ?? 0, this.resources[name]);
  }

  setResource(name: string, value: number): void {
    if (!this.isEnabled()) return;
    this.resources[name] = Math.max(0, value);
    this.highWater[name] = Math.max(this.highWater[name] ?? 0, this.resources[name]);
  }

  report(): Gate0Report {
    return structuredClone({
      enabled: this.isEnabled(),
      startedAt: this.startedAt,
      records: this.records,
      events: this.events,
      resources: this.resources,
      highWater: this.highWater,
      dropped: this.dropped,
    });
  }
}

export const gate0Profiler = new Gate0Profiler();

if (typeof window !== 'undefined' && isDevelopmentBuild) {
  window.__PANVAS_GATE0_PROFILER__ = {
    enable: () => window.localStorage.setItem(STORAGE_KEY, '1'),
    disable: () => window.localStorage.removeItem(STORAGE_KEY),
    reset: () => gate0Profiler.reset(),
    report: () => gate0Profiler.report(),
  };
}
