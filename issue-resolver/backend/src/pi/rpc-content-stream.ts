import type { SessionEvent } from '@issue-resolver/shared';

export interface ContentStreamHandlers {
  onUpdate: (contentIndex: number, partialText: string) => void;
  onEmit: (text: string) => void;
  extract: (content: unknown) => string | null;
}

export class ContentStream {
  private readonly byIndex = new Map<number, string>();
  private readonly order: number[] = [];
  private readonly emitted = new Set<number>();

  constructor(private readonly handlers: ContentStreamHandlers) {}

  text(): string {
    return this.order.map((index) => this.byIndex.get(index) ?? '').join('');
  }

  append(index: number, delta: string): void {
    if (delta.length === 0) return;
    if (!this.byIndex.has(index)) {
      this.byIndex.set(index, '');
      this.order.push(index);
    }
    const partialText = `${this.byIndex.get(index) ?? ''}${delta}`;
    this.byIndex.set(index, partialText);
    this.handlers.onUpdate(index, partialText);
  }

  finalize(index: number, content: unknown): void {
    const text = this.handlers.extract(content);
    if (text !== null) {
      if (!this.byIndex.has(index)) this.order.push(index);
      this.byIndex.set(index, text);
    }
    this.emit(index);
  }

  flush(): void {
    for (const index of this.order) this.emit(index);
  }

  reset(): void {
    this.byIndex.clear();
    this.order.length = 0;
    this.emitted.clear();
  }

  private emit(index: number): void {
    if (this.emitted.has(index)) return;
    this.emitted.add(index);
    const text = this.byIndex.get(index) ?? '';
    if (text.length === 0) return;
    this.handlers.onEmit(text);
  }
}