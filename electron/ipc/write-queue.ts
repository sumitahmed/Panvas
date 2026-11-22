import { promises as fsPromises } from 'fs';

export type AtomicWriteData = string | Uint8Array;
export type WritePriority = 'foreground' | 'background';

interface WriteTask {
  filePath: string;
  data: AtomicWriteData;
  priority: WritePriority;
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface FlushWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class WriteQueue {
  private foregroundQueue: WriteTask[] = [];
  private backgroundQueue: WriteTask[] = [];
  private isWriting = false;
  private tempSequence = 0;
  private taskSequence = 0;
  private acceptingWrites = true;
  private lastFailure: Error | null = null;
  private flushWaiters: FlushWaiter[] = [];

  private get totalQueued(): number {
    return this.foregroundQueue.length + this.backgroundQueue.length;
  }

  async enqueue(filePath: string, data: AtomicWriteData, priority: WritePriority = 'foreground'): Promise<void> {
    if (!this.acceptingWrites) throw new Error('Write queue is shutting down.');
    return new Promise((resolve, reject) => {
      const task: WriteTask = { filePath, data, priority, seq: ++this.taskSequence, resolve, reject };
      if (priority === 'foreground') {
        this.foregroundQueue.push(task);
      } else {
        this.backgroundQueue.push(task);
      }
      this.processNext();
    });
  }

  beginShutdown(): void {
    this.acceptingWrites = false;
  }

  async flush(): Promise<void> {
    if (!this.isWriting && this.totalQueued === 0) {
      const failure = this.takeFailure();
      if (failure) throw failure;
      return;
    }
    return new Promise((resolve, reject) => {
      this.flushWaiters.push({ resolve, reject });
    });
  }

  private async processNext(): Promise<void> {
    if (this.isWriting || this.totalQueued === 0) return;
    this.isWriting = true;
    try {
      // Drain foreground interactive writes before background sync writes while
      // preserving exact sequence-ordered latest-writer-wins per target path.
      const isForegroundPass = this.foregroundQueue.length > 0;
      const batch = isForegroundPass
        ? this.foregroundQueue.splice(0)
        : this.backgroundQueue.splice(0);

      const taskMap = new Map<string, WriteTask[]>();
      const maxSeqByPath = new Map<string, number>();
      for (const task of batch) {
        const tasks = taskMap.get(task.filePath) ?? [];
        tasks.push(task);
        taskMap.set(task.filePath, tasks);
        const prevSeq = maxSeqByPath.get(task.filePath) ?? 0;
        if (task.seq > prevSeq) maxSeqByPath.set(task.filePath, task.seq);
      }

      if (isForegroundPass && this.backgroundQueue.length > 0) {
        const remainingBg: WriteTask[] = [];
        for (const bgTask of this.backgroundQueue) {
          const maxFgSeq = maxSeqByPath.get(bgTask.filePath);
          if (maxFgSeq !== undefined && bgTask.seq < maxFgSeq) {
            taskMap.get(bgTask.filePath)!.unshift(bgTask);
          } else {
            remainingBg.push(bgTask);
          }
        }
        this.backgroundQueue = remainingBg;
      }

      for (const [filePath, tasks] of taskMap.entries()) {
        tasks.sort((a, b) => a.seq - b.seq);
        const latest = tasks[tasks.length - 1];
        try {
          await this.atomicWrite(filePath, latest.data);
          tasks.forEach(({ resolve }) => resolve());
        } catch (error) {
          const failure = error instanceof Error ? error : new Error('Atomic write failed.');
          this.lastFailure ??= failure;
          tasks.forEach(({ reject }) => reject(failure));
        }
      }
    } finally {
      this.isWriting = false;
      if (this.totalQueued > 0) void this.processNext();
      else this.settleFlushWaiters();
    }
  }

  private takeFailure(): Error | null {
    const failure = this.lastFailure;
    this.lastFailure = null;
    return failure;
  }

  private settleFlushWaiters(): void {
    if (this.isWriting || this.totalQueued > 0 || this.flushWaiters.length === 0) return;
    const waiters = this.flushWaiters.splice(0);
    const failure = this.takeFailure();
    for (const waiter of waiters) {
      if (failure) waiter.reject(failure);
      else waiter.resolve();
    }
  }

  // DATA SAFETY: Atomic file replacement invariant.
  // 1. Write payload to unique PID-sequenced temporary file.
  // 2. Call fsync() to guarantee hardware disk flush before rename.
  // 3. Rename over target path atomically to ensure the file is never truncated on crash.
  // 4. Retry boundedly on Windows EBUSY/EPERM lock collisions with exponential backoff & jitter.
  private async atomicWrite(targetPath: string, data: AtomicWriteData) {
    const tempPath = `${targetPath}.tmp-${process.pid}-${++this.tempSequence}`;
    let handle: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
    try {
      handle = await fsPromises.open(tempPath, 'w');
      await handle.writeFile(data, typeof data === 'string' ? { encoding: 'utf8' } : undefined);
      await handle.sync();
      await handle.close();
      handle = null;

      // Cloud-sync/indexer processes commonly hold a just-written file for a
      // short period on Windows. Keep retries bounded while giving those
      // transient locks time to clear; permanent errors still reject and the
      // previous target remains untouched because the temp file is separate.
      let retries = 10;
      let delay = 50;
      while (retries > 0) {
        try {
          await fsPromises.rename(tempPath, targetPath);
          return;
        } catch (err: any) {
          if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
            retries--;
            if (retries === 0) throw err;
            const jitter = Math.floor(Math.random() * 25);
            await new Promise(resolve => setTimeout(resolve, Math.min(1000, delay + jitter)));
            delay = Math.min(1000, delay * 2);
          } else {
            throw err;
          }
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export const writeQueue = new WriteQueue();
