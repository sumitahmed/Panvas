/** Transient input data only; the persisted StrokePoint schema is unchanged. */
export interface InkSample {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  pressure: number;
  timeStamp: number;
  source: string;
}

export type InkDispatch = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'clientX' | 'clientY' | 'pressure' | 'timeStamp' | 'type'> & {
  getCoalescedEvents?: () => InkDispatch[];
};

/** Merge both transports by sample identity, retaining late unique history in order. */
export class InkSamples {
  readonly samples: InkSample[] = [];
  private seen = new Set<string>();
  readonly pointerId: number;
  readonly pointerType: string;
  readonly startedAt: number;

  constructor(down: InkDispatch) {
    this.pointerId = down.pointerId;
    this.pointerType = down.pointerType;
    this.startedAt = down.timeStamp;
  }

  owns(event: Pick<InkSample, 'pointerId' | 'pointerType'>): boolean {
    return event.pointerId === this.pointerId && event.pointerType === this.pointerType;
  }

  consume(event: InkDispatch) {
    const result = { added: 0, rebuild: false, coalesced: 0, duplicates: 0, stationaryUp: 0, rejectedOwner: 0, invalid: 0, raw: [] as InkSample[] };
    if (!this.owns(event)) { result.rejectedOwner++; return result; }
    const history = event.getCoalescedEvents?.() ?? [];
    result.coalesced = history.length;
    const candidates = [...history, event].map(sample => ({
      pointerId: sample.pointerId, pointerType: sample.pointerType,
      clientX: sample.clientX, clientY: sample.clientY, pressure: sample.pressure,
      timeStamp: sample.timeStamp, source: event.type,
    })).sort((a, b) => a.timeStamp - b.timeStamp);
    for (const sample of candidates) {
      result.raw.push(sample);
      if (!this.owns(sample)) { result.rejectedOwner++; continue; }
      if (![sample.clientX, sample.clientY, sample.pressure, sample.timeStamp].every(Number.isFinite)
        || sample.timeStamp < this.startedAt) { result.invalid++; continue; }
      const key = `${sample.timeStamp}/${sample.clientX}/${sample.clientY}/${sample.pressure}`;
      if (this.seen.has(key)) { result.duplicates++; continue; }
      const last = this.samples[this.samples.length - 1];
      // Pointer-up's pressure release is not another mark when its endpoint is already present.
      if (event.type === 'pointerup' && sample.timeStamp === event.timeStamp
        && last && last.clientX === sample.clientX && last.clientY === sample.clientY) {
        result.stationaryUp++; continue;
      }
      this.seen.add(key);
      if (!last || sample.timeStamp >= last.timeStamp) this.samples.push(sample);
      else {
        let low = 0, high = this.samples.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (this.samples[mid].timeStamp <= sample.timeStamp) low = mid + 1;
          else high = mid;
        }
        this.samples.splice(low, 0, sample);
        result.rebuild = true;
      }
      result.added++;
    }
    return result;
  }
}
