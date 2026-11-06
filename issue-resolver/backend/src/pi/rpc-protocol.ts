import type { ControlResult } from '@issue-resolver/shared';
import { isRpcEvent, type RpcEvent } from './rpc-events';
import { JSON_PARSE_FAILED, tryParseJson } from '../util/json-file';

const SEND_TIMEOUT_MS = 10000;

export interface RpcChannelHandlers {
  onEvent: (event: RpcEvent) => void;
}

export class RpcChannel {
  private buffer = '';
  private requestSeq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (result: ControlResult) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly stdin: NodeJS.WritableStream | null | undefined,
    private readonly handlers: RpcChannelHandlers,
  ) {}

  write(command: Record<string, unknown>): boolean {
    if (!this.stdin?.writable) return false;
    try {
      this.stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  send(
    command: Record<string, unknown>,
    timeoutMs = SEND_TIMEOUT_MS,
  ): Promise<ControlResult> {
    const id = `ctl-${++this.requestSeq}`;
    return new Promise<ControlResult>((resolveCommand) => {
      if (!this.stdin?.writable) {
        resolveCommand({ ok: false, error: 'session closed' });
        return;
      }
      const entryTimer = setTimeout(() => {
        this.pending.delete(id);
        resolveCommand({ ok: false, error: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCommand, timer: entryTimer });
      try {
        this.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      } catch {
        clearTimeout(entryTimer);
        this.pending.delete(id);
        resolveCommand({ ok: false, error: 'write failed' });
      }
    });
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  flushBuffer(): void {
    if (this.buffer.length === 0) return;
    const line = this.buffer;
    this.buffer = '';
    this.handleLine(line);
  }

  settlePending(error: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error });
    }
    this.pending.clear();
  }

  resolvePending(event: RpcEvent): boolean {
    if (event.type !== 'response' || typeof event.id !== 'string') return false;
    const entry = this.pending.get(event.id);
    if (!entry) return false;
    this.pending.delete(event.id);
    clearTimeout(entry.timer);
    const { data } = event;
    entry.resolve(
      event.success === false
        ? {
            ok: false,
            error:
              typeof event.error === 'string' ? event.error : 'command failed',
            ...(data !== undefined ? { data } : {}),
          }
        : { ok: true, ...(data !== undefined ? { data } : {}) },
    );
    return true;
  }

  private handleLine(raw: string): void {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0) return;

    const event = tryParseJson(line);
    if (event === JSON_PARSE_FAILED || !isRpcEvent(event)) return;
    this.handlers.onEvent(event);
  }
}