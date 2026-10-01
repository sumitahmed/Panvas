/** Shared synchronous ownership of manual notebook navigation. */
export class NavigationGestureLifecycle {
  private owners = new Set<symbol>();
  private idleListeners = new Set<() => void>();

  get active(): boolean {
    return this.owners.size > 0;
  }

  /** Acquire before canceling a previous owner when promoting a gesture. */
  begin(): () => void {
    const owner = Symbol('navigation');
    this.owners.add(owner);
    return () => {
      if (!this.owners.delete(owner) || this.active) return;
      for (const listener of this.idleListeners) listener();
    };
  }

  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => this.idleListeners.delete(listener);
  }
}
