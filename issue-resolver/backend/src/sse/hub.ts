import type { SSEEvent } from '@issue-resolver/shared';

export type SseListener = (event: SSEEvent) => void;

export interface SseHub {
  publish(event: SSEEvent): void;
  subscribe(iterationId: string, listener: SseListener): () => void;
  subscribeByIssue(issueId: string, listener: SseListener): () => void;
  subscribeGlobal(listener: SseListener): () => void;
}

export class InMemorySseHub implements SseHub {
  private readonly listeners = new Map<string, Set<SseListener>>();
  private readonly issueListeners = new Map<string, Set<SseListener>>();
  private readonly globalListeners = new Set<SseListener>();

  publish(event: SSEEvent): void {
    const targets = new Set<SseListener>();
    if (event.iterationId) {
      for (const listener of this.listeners.get(event.iterationId) ?? []) {
        targets.add(listener);
      }
    }
    for (const listener of this.issueListeners.get(event.issueId) ?? []) {
      targets.add(listener);
    }
    for (const listener of this.globalListeners) {
      targets.add(listener);
    }
    for (const listener of targets) {
      listener(event);
    }
  }

  subscribe(iterationId: string, listener: SseListener): () => void {
    return this.addListener(this.listeners, iterationId, listener);
  }

  subscribeByIssue(issueId: string, listener: SseListener): () => void {
    return this.addListener(this.issueListeners, issueId, listener);
  }

  subscribeGlobal(listener: SseListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  private addListener(
    registry: Map<string, Set<SseListener>>,
    key: string,
    listener: SseListener,
  ): () => void {
    let set = registry.get(key);
    if (!set) {
      set = new Set();
      registry.set(key, set);
    }
    set.add(listener);

    return () => {
      const current = registry.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        registry.delete(key);
      }
    };
  }
}