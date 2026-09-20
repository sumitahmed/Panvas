export type SceneMutationChannel = 'drawing' | 'history';

/**
 * Converts the engine's two compatibility notification channels into one logical mutation.
 * Paired notifications are synchronous but can arrive in either order (normal commit versus
 * undo/redo). Independent browser events are separated by the microtask boundary.
 */
export class SceneMutationCoordinator {
  private pendingChannel: SceneMutationChannel | null = null;
  private pairToken = 0;

  accept(channel: SceneMutationChannel): boolean {
    if (this.pendingChannel && this.pendingChannel !== channel) {
      this.pendingChannel = null;
      this.pairToken += 1;
      return false;
    }
    this.pendingChannel = channel;
    const token = ++this.pairToken;
    queueMicrotask(() => {
      if (this.pairToken === token) this.pendingChannel = null;
    });
    return true;
  }

  clear(): void {
    this.pendingChannel = null;
    this.pairToken += 1;
  }
}
