// ============================================
// Panvas — History Manager (Unified Undo/Redo)
// ============================================
// Single command history shared across text and drawing.
// Every user action becomes a HistoryCommand with execute() and undo().

import type { HistoryCommand } from './drawingTypes.ts';
import { gate0Profiler } from '../../../dev/gate0Profiler.ts';

export type HistoryChangeSource = 'user' | 'load';
export type HistoryChangeListener = (
  canUndo: boolean,
  canRedo: boolean,
  source: HistoryChangeSource,
) => void;

export class HistoryManager {
  private undoStack: HistoryCommand[] = [];
  private redoStack: HistoryCommand[] = [];
  private maxSize: number;
  private listeners: Set<HistoryChangeListener> = new Set();

  constructor(maxSize: number = 200) {
    this.maxSize = maxSize;
  }

  /** Subscribe to undo/redo state changes. Returns unsubscribe function. */
  subscribe(listener: HistoryChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(source: HistoryChangeSource = 'user'): void {
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    const canUndo = this.undoStack.length > 0;
    const canRedo = this.redoStack.length > 0;
    for (const listener of this.listeners) {
      listener(canUndo, canRedo, source);
    }
    if (startedAt) gate0Profiler.event('history-notification', performance.now() - startedAt, { listeners: this.listeners.size, source });
  }

  /** Push a new command and execute it. Clears the redo stack. */
  push(command: HistoryCommand): void {
    command.execute();
    this.undoStack.push(command);

    // Trim oldest entries if over max size
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }

    // New action invalidates redo
    this.redoStack.length = 0;
    this.notify();
  }

  /**
   * Executes one atomic transform and removes the earlier creation commands for
   * the exact source objects it consumed. Undo then steps between transforms,
   * rather than exposing the implementation detail of each source stroke.
   */
  pushReplacingCreations(command: HistoryCommand, replacedObjectIds: readonly string[]): void {
    command.execute();
    const replaced = new Set(replacedObjectIds);
    this.undoStack = this.undoStack.filter(existing => (
      !existing.createdObjectIds?.some(id => replaced.has(id))
    ));
    this.undoStack.push(command);
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack.length = 0;
    this.notify();
  }

  /** Push a command that has ALREADY been executed (e.g., during live drawing). */
  pushExecuted(command: HistoryCommand): void {
    this.undoStack.push(command);
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.notify();
  }

  /** Undo the last command. */
  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.notify();
  }

  /** Redo the last undone command. */
  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    command.execute();
    this.undoStack.push(command);
    this.notify();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Clear all history. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notify('load');
  }
}
