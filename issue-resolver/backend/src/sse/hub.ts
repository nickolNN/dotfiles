import type { SSEEvent } from '@issue-resolver/shared';

/** Слушатель событий SSE по одной итерации. */
export type SseListener = (event: SSEEvent) => void;

/** Портовый интерфейс шины событий: publish/subscribe по iterationId и issueId. */
export interface SseHub {
  publish(event: SSEEvent): void;
  subscribe(iterationId: string, listener: SseListener): () => void;
  subscribeByIssue(issueId: string, listener: SseListener): () => void;
}

/**
 * In-memory реализация шины SSE.
 *
 * События доставляются слушателям, подписанным либо на совпадающий
 * `event.iterationId`, либо на совпадающий `event.issueId`. Один и тот же
 * слушатель, подписанный обоими способами, получит событие ровно один раз.
 * subscribe()/subscribeByIssue() возвращают функцию отписки.
 */
export class InMemorySseHub implements SseHub {
  private readonly listeners = new Map<string, Set<SseListener>>();
  private readonly issueListeners = new Map<string, Set<SseListener>>();

  publish(event: SSEEvent): void {
    const targets = new Set<SseListener>();
    for (const listener of this.listeners.get(event.iterationId) ?? []) {
      targets.add(listener);
    }
    for (const listener of this.issueListeners.get(event.issueId) ?? []) {
      targets.add(listener);
    }
    // Копия не нужна: Set уже отделяет доставку от мутаций реестра.
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