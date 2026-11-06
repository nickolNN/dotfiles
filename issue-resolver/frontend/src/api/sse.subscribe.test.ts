import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToAgentEvents, subscribeToIssueEvents } from './sse';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data } as MessageEvent);
  }
}

const envelope = (overrides: Record<string, unknown> = {}): unknown => ({
  type: 'step_status',
  issueId: 'issue-1',
  data: JSON.stringify({ status: 'running' }),
  ts: '2026-10-13T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('subscribeToIssueEvents — конверт SSE', () => {
  it('валидный конверт доезжает до колбэка', () => {
    const onStepStatus = vi.fn();
    subscribeToIssueEvents('issue-1', { onStepStatus });

    FakeEventSource.instances[0].emit(envelope());

    expect(onStepStatus).toHaveBeenCalledTimes(1);
    expect(onStepStatus.mock.calls[0][0]).toMatchObject({
      type: 'step_status',
      issueId: 'issue-1',
    });
  });

  it('отбрасывает неизвестный конверт и конверт без data/ts', () => {
    const onStepStatus = vi.fn();
    const onError = vi.fn();
    subscribeToIssueEvents('issue-1', { onStepStatus, onError });
    const source = FakeEventSource.instances[0];

    source.emit(envelope({ type: 'nope' }));
    source.emit(envelope({ issueId: undefined }));
    source.emit(envelope({ data: undefined }));
    source.emit(envelope({ ts: 42 }));

    expect(onStepStatus).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('битый JSON → onError, поток не рвётся', () => {
    const onStepStatus = vi.fn();
    const onError = vi.fn();
    subscribeToIssueEvents('issue-1', { onStepStatus, onError });
    const source = FakeEventSource.instances[0];

    source.emit('не json');
    source.emit(envelope());

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onStepStatus).toHaveBeenCalledTimes(1);
  });
});

describe('subscribeToAgentEvents — конверт и плоское событие', () => {
  it('плоское session-событие без конверта доезжает', () => {
    const onEvent = vi.fn();
    subscribeToAgentEvents('iter-1', 'agent-1', { onEvent });

    FakeEventSource.instances[0].emit({ type: 'text', text: 'привет' });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      event: { type: 'text', text: 'привет' },
    });
  });

  it('неизвестный конверт не роняет поток', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribeToAgentEvents('iter-1', 'agent-1', { onEvent, onError });
    const source = FakeEventSource.instances[0];

    source.emit({ type: 'nope', issueId: 'issue-1', data: '', ts: 't' });
    source.emit({
      type: 'step_event',
      issueId: 'issue-1',
      agentId: 'agent-1',
      data: JSON.stringify({ event: { type: 'text', text: 'дальше' } }),
      ts: '2026-10-13T00:00:00.000Z',
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      event: { type: 'text', text: 'дальше' },
    });
  });
});