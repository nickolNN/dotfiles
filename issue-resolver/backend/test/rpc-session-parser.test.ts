import { describe, expect, it } from 'vitest';
import type { SessionEvent, SessionStats } from '@issue-resolver/shared';
import { RpcSessionParser } from '../src/pi/rpc-runner';

describe('RpcSessionParser', () => {
  it('text_delta идёт в stdout, toolcall_delta — нет', () => {
    const out: string[] = [];
    const parser = new RpcSessionParser({ onStdout: (chunk) => out.push(chunk) });

    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' },
    });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'world' },
    });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 1,
        id: 't1',
        toolName: 'bash',
      },
    });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 1,
        delta: '{"command":"pwd"}',
      },
    });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello world' },
    });

    expect(out).toEqual(['Hello ', 'world']);
    expect(parser.stdout()).toBe('Hello world');
    expect(parser.stdout()).not.toContain('command');
    expect(parser.events()).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('tool_execution_start/end → tool_use/tool_result (тексты content[])', () => {
    const events: SessionEvent[] = [];
    const parser = new RpcSessionParser({ onEvent: (event) => events.push(event) });

    parser.handle({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    parser.handle({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      isError: false,
      durationMs: 5,
      result: {
        content: [
          { type: 'text', text: '/x' },
          { type: 'text', text: '/y' },
        ],
        structuredContent: { cwd: '/x' },
      },
    });

    expect(events).toEqual([
      {
        type: 'tool_use',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'pwd' },
      },
      {
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: false,
        durationMs: 5,
        resultText: '/x/y',
      },
    ]);
  });

  it('tool_result без content-текста → JSON structuredContent', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'tool_execution_end',
      toolCallId: 'c2',
      toolName: 'x',
      isError: true,
      result: { structuredContent: { error: 'boom' } },
    });

    expect(parser.events()).toEqual([
      {
        type: 'tool_result',
        toolCallId: 'c2',
        toolName: 'x',
        isError: true,
        durationMs: null,
        resultText: JSON.stringify({ error: 'boom' }),
      },
    ]);
  });

  it('flush: текст без text_end не теряется', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' },
    });
    parser.flush();

    expect(parser.stdout()).toBe('partial');
    expect(parser.events()).toEqual([{ type: 'text', text: 'partial' }]);
  });

  it('thinking_delta + thinking_end → событие thinking, не в stdout', () => {
    const out: string[] = [];
    const events: SessionEvent[] = [];
    const parser = new RpcSessionParser({
      onStdout: (chunk) => out.push(chunk),
      onEvent: (event) => events.push(event),
    });

    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
    });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'думаю ' },
    });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'над этим' },
    });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_end',
        contentIndex: 0,
        content: { type: 'thinking', thinking: 'думаю над этим' },
      },
    });

    expect(out).toEqual([]);
    expect(parser.stdout()).toBe('');
    expect(events).toEqual([{ type: 'thinking', thinking: 'думаю над этим' }]);
    expect(parser.events()).toEqual([{ type: 'thinking', thinking: 'думаю над этим' }]);
  });

  it('thinking_end со строковым content → авторитетный текст', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'строка' },
    });

    expect(parser.events()).toEqual([{ type: 'thinking', thinking: 'строка' }]);
  });

  it('flush: накопленное thinking без thinking_end не теряется', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'частично' },
    });
    parser.flush();

    expect(parser.events()).toEqual([{ type: 'thinking', thinking: 'частично' }]);
  });

  it('message_start сбрасывает аккумуляторы: каждое сообщение эмитит свои thinking+text', () => {
    const events: SessionEvent[] = [];
    const parser = new RpcSessionParser({ onEvent: (event) => events.push(event) });

    const assistantMessage = (tag: string): void => {
      parser.handle({ type: 'message_start', message: { role: 'assistant' } });
      parser.handle({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: `${tag} думаю` },
      });
      parser.handle({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: { type: 'thinking', thinking: `${tag} думаю` },
        },
      });
      parser.handle({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: `${tag} текст` },
      });
      parser.handle({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: `${tag} текст` },
      });
      parser.handle({ type: 'message_end', message: { role: 'assistant' } });
    };

    assistantMessage('M1');
    assistantMessage('M2');
    assistantMessage('M3');

    // Регрессия: раньше был ровно 1 thinking + 1 text на всю сессию.
    expect(events.map((event) => event.type)).toEqual([
      'thinking',
      'text',
      'thinking',
      'text',
      'thinking',
      'text',
    ]);
    expect(events).toEqual([
      { type: 'thinking', thinking: 'M1 думаю' },
      { type: 'text', text: 'M1 текст' },
      { type: 'thinking', thinking: 'M2 думаю' },
      { type: 'text', text: 'M2 текст' },
      { type: 'thinking', thinking: 'M3 думаю' },
      { type: 'text', text: 'M3 текст' },
    ]);
    expect(events.filter((event) => event.type === 'thinking')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'text')).toHaveLength(3);
    expect(parser.events()).toEqual(events);
  });

  it('message_start: role:user не сбрасывает, без role — сбрасывает', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'a' },
    });
    // user-сообщение не является блоком ассистента — аккумулятоp не трогаем.
    parser.handle({ type: 'message_start', message: { role: 'user' } });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'b' },
    });
    // message_start без role — новый блок ассистента: flush + сброс.
    parser.handle({ type: 'message_start' });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'c' },
    });
    parser.handle({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'c' },
    });

    expect(parser.events()).toEqual([
      { type: 'thinking', thinking: 'ab' },
      { type: 'thinking', thinking: 'c' },
    ]);
  });

  it('message_update.usage → событие usage (totalTokens→total, cost-объект)', () => {
    const events: SessionEvent[] = [];
    const parser = new RpcSessionParser({ onEvent: (event) => events.push(event) });

    parser.handle({
      type: 'message_update',
      usage: {
        input: 100,
        output: 1,
        cacheRead: 2,
        cacheWrite: 3,
        totalTokens: 106,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      },
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Hi ',
      },
    });

    expect(events).toEqual([
      {
        type: 'usage',
        usage: { input: 100, output: 1, cacheRead: 2, cacheWrite: 3, total: 106 },
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      },
    ]);
  });

  it('usage: дедуп по total, числа→0, нечисловой cost → null', () => {
    const events: SessionEvent[] = [];
    const parser = new RpcSessionParser({ onEvent: (event) => events.push(event) });

    const emit = (usage: unknown) =>
      parser.handle({ type: 'message_update', usage });

    emit({ input: 1, totalTokens: 5, cost: 'nope' });
    emit({ input: 2, totalTokens: 5 }); // тот же total — дубль
    emit({ input: 'x', output: 2, totalTokens: 7 }); // total вырос → эмит
    emit({ input: 3 }); // без totalTokens: total = сумма чисел

    expect(events).toEqual([
      {
        type: 'usage',
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
        cost: null,
      },
      {
        type: 'usage',
        usage: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, total: 7 },
        cost: null,
      },
      {
        type: 'usage',
        usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
        cost: null,
      },
    ]);
  });

  it('get_session_stats response → parser.stats() и onStats', () => {
    const seen: unknown[] = [];
    const parser = new RpcSessionParser({ onStats: (stats) => seen.push(stats) });

    parser.handle({
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: {
        sessionId: 's1',
        userMessages: 2,
        assistantMessages: 2,
        toolCalls: 3,
        toolResults: 3,
        totalMessages: 7,
        tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, total: 18 },
        cost: 0.5,
        contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
      },
    });

    expect(parser.stats()).toEqual({
      sessionId: 's1',
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 3,
      toolResults: 3,
      totalMessages: 7,
      tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, total: 18 },
      cost: 0.5,
      contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
    });
    expect(seen).toEqual([parser.stats()]);
  });

  it('get_session_stats response → событие stats (onEvent и collected)', () => {
    const events: SessionEvent[] = [];
    const parser = new RpcSessionParser({
      onEvent: (event) => events.push(event),
    });

    parser.handle({
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: {
        userMessages: 1,
        assistantMessages: 1,
        tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
        cost: 0.1,
        contextUsage: { tokens: 3, contextWindow: 100, percent: 3 },
      },
    });

    const expected = { type: 'stats', stats: parser.stats() };
    expect(events).toEqual([expected]);
    expect(parser.events()).toEqual([expected]);
  });

  it('get_session_stats без contextUsage/tokens → нули и null', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: { userMessages: 1, cost: 0 },
    });

    const stats = parser.stats();
    expect(stats?.contextUsage).toBeNull();
    expect(stats?.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
    expect(stats?.cost).toBe(0);
  });

  it('get_state: модель (name) переносится в stats и событие stats', () => {
    const seen: SessionStats[] = [];
    const events: SessionEvent[] = [];
    const parser = new RpcSessionParser({
      onStats: (stats) => seen.push(stats),
      onEvent: (event) => events.push(event),
    });

    parser.handle({
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        model: { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' },
      },
    });
    parser.handle({
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: { userMessages: 1 },
    });

    expect(parser.stats()?.model).toBe('Claude Sonnet 4');
    expect(seen).toEqual([parser.stats()]);
    expect(events).toEqual([{ type: 'stats', stats: parser.stats() }]);
  });

  it('get_session_stats без get_state → stats без model', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: { userMessages: 1 },
    });

    expect(parser.stats()).not.toHaveProperty('model');
  });

  it('get_state без name → model = id', () => {
    const parser = new RpcSessionParser();

    for (const name of [undefined, '']) {
      parser.handle({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { model: { id: 'llama-3.3-70b', ...(name !== undefined ? { name } : {}) } },
      });
      parser.handle({
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {},
      });
    }

    expect(parser.stats()?.model).toBe('llama-3.3-70b');
  });

  it('extension_ui_request select/input → question-событие', () => {
    const events: SessionEvent[] = [];
    const parser = new RpcSessionParser({
      onEvent: (event) => events.push(event),
    });

    parser.handle({
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'select',
      title: 'Выберите шаг',
      message: 'Что делать?',
      options: ['refine', 'resolve'],
      placeholder: 'выбор',
      prefill: 'refine',
    });
    parser.handle({
      type: 'extension_ui_request',
      id: 'ui-2',
      method: 'input',
      title: 'Ввод',
    });

    expect(events).toEqual([
      {
        type: 'question',
        id: 'ui-1',
        method: 'select',
        title: 'Выберите шаг',
        message: 'Что делать?',
        options: ['refine', 'resolve'],
        placeholder: 'выбор',
        prefill: 'refine',
      },
      { type: 'question', id: 'ui-2', method: 'input', title: 'Ввод' },
    ]);
    expect(parser.events()).toEqual(events);
  });

  it('extension_ui_request с невалидным id/method игнорируется', () => {
    const parser = new RpcSessionParser();
    // Сырой JSON: id/method не-строки должны отсекаться на рантайме.
    const raw = (event: Record<string, unknown>): void =>
      parser.handle(event as never);

    raw({ type: 'extension_ui_request', method: 'select', title: 'x' });
    raw({ type: 'extension_ui_request', id: 'ui-1', title: 'x' });
    raw({ type: 'extension_ui_request', id: 42, method: 'select' });
    raw({ type: 'extension_ui_request', id: 'ui-2', method: 7 });

    expect(parser.events()).toEqual([]);
  });

  it('extension_ui_request confirm/editor → question-событие', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'extension_ui_request',
      id: 'ui-c',
      method: 'confirm',
      title: 'Продолжить?',
    });
    parser.handle({
      type: 'extension_ui_request',
      id: 'ui-e',
      method: 'editor',
      title: 'Редактор',
      prefill: 'текст',
    });

    expect(parser.events()).toEqual([
      { type: 'question', id: 'ui-c', method: 'confirm', title: 'Продолжить?' },
      {
        type: 'question',
        id: 'ui-e',
        method: 'editor',
        title: 'Редактор',
        prefill: 'текст',
      },
    ]);
  });

  it('tool_execution_update → tool_update с partialText', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'tool_execution_update',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'ls' },
      partialResult: {
        content: [
          { type: 'text', text: 'part1 ' },
          { type: 'text', text: 'part2' },
        ],
      },
    });

    expect(parser.events()).toEqual([
      {
        type: 'tool_update',
        toolCallId: 'c1',
        toolName: 'bash',
        partialText: 'part1 part2',
      },
    ]);
  });

  it('compaction_start/end → события с result-полями и aborted-веткой', () => {
    const parser = new RpcSessionParser();

    parser.handle({ type: 'compaction_start', reason: 'threshold' });
    parser.handle({
      type: 'compaction_end',
      reason: 'threshold',
      result: {
        summary: 'сжали',
        tokensBefore: 150000,
        estimatedTokensAfter: 32000,
      },
      aborted: false,
      willRetry: true,
    });
    parser.handle({
      type: 'compaction_end',
      reason: 'overflow',
      aborted: true,
      errorMessage: 'boom',
    });

    expect(parser.events()).toEqual([
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        summary: 'сжали',
        aborted: false,
        willRetry: true,
        errorMessage: null,
        tokensBefore: 150000,
        estimatedTokensAfter: 32000,
      },
      {
        type: 'compaction_end',
        reason: 'overflow',
        summary: null,
        aborted: true,
        willRetry: false,
        errorMessage: 'boom',
        tokensBefore: null,
        estimatedTokensAfter: null,
      },
    ]);
  });

  it('auto_retry_start/end → retry_start/retry_end (kind auto)', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: '529 overloaded',
    });
    parser.handle({
      type: 'auto_retry_end',
      success: false,
      attempt: 3,
      finalError: 'gave up',
    });

    expect(parser.events()).toEqual([
      {
        type: 'retry_start',
        kind: 'auto',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: '529 overloaded',
        source: null,
        reason: null,
      },
      {
        type: 'retry_end',
        kind: 'auto',
        success: false,
        attempt: 3,
        finalError: 'gave up',
      },
    ]);
  });

  it('summarization_retry_scheduled/finished → retry_*; attempt_start игнорируется', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'summarization_retry_scheduled',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1500,
      errorMessage: 'terminated',
    });
    parser.handle({
      type: 'summarization_retry_attempt_start',
      source: 'compaction',
      reason: 'threshold',
    });
    parser.handle({ type: 'summarization_retry_finished' });

    expect(parser.events()).toEqual([
      {
        type: 'retry_start',
        kind: 'summarization',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1500,
        errorMessage: 'terminated',
        source: null,
        reason: null,
      },
      {
        type: 'retry_end',
        kind: 'summarization',
        success: null,
        attempt: null,
        finalError: null,
      },
    ]);
  });

  it('queue_update → queue с массивами строк', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'queue_update',
      steering: ['стой', 42],
      followUp: ['потом'],
    });
    parser.handle({ type: 'queue_update' });

    expect(parser.events()).toEqual([
      { type: 'queue', steering: ['стой'], followUp: ['потом'] },
      { type: 'queue', steering: [], followUp: [] },
    ]);
  });

  it('thinking_level_changed / session_info_changed → события', () => {
    const parser = new RpcSessionParser();

    parser.handle({ type: 'thinking_level_changed', level: 'high' });
    parser.handle({ type: 'session_info_changed', name: 'исследование' });
    parser.handle({ type: 'session_info_changed' });

    expect(parser.events()).toEqual([
      { type: 'thinking_level', level: 'high' },
      { type: 'session_info', name: 'исследование' },
      { type: 'session_info', name: null },
    ]);
  });

  it('extension_error и bash_execution_update → события', () => {
    const parser = new RpcSessionParser();

    parser.handle({ type: 'extension_error', error: 'boom' });
    parser.handle({ type: 'bash_execution_update', delta: 'out\n' });

    expect(parser.events()).toEqual([
      { type: 'extension_error', message: 'boom' },
      { type: 'bash', delta: 'out\n' },
    ]);
  });

  it('fire-and-forget UI → notice/status/widget/title/editor_text, не question', () => {
    const parser = new RpcSessionParser();

    parser.handle({
      type: 'extension_ui_request',
      id: 'u1',
      method: 'notify',
      message: 'внимание',
      notifyType: 'warning',
    });
    parser.handle({
      type: 'extension_ui_request',
      id: 'u2',
      method: 'setStatus',
      statusKey: 'ext',
      statusText: 'работаю',
    });
    parser.handle({
      type: 'extension_ui_request',
      id: 'u3',
      method: 'setStatus',
      statusKey: 'ext',
    });
    parser.handle({
      type: 'extension_ui_request',
      id: 'u4',
      method: 'setWidget',
      widgetKey: 'w',
      widgetLines: ['a', 'b'],
      widgetPlacement: 'belowEditor',
    });
    parser.handle({
      type: 'extension_ui_request',
      id: 'u5',
      method: 'setWidget',
      widgetKey: 'w',
    });
    parser.handle({
      type: 'extension_ui_request',
      id: 'u6',
      method: 'setTitle',
      title: 'pi - demo',
    });
    parser.handle({
      type: 'extension_ui_request',
      id: 'u7',
      method: 'set_editor_text',
      text: 'заполнено',
    });

    expect(parser.events()).toEqual([
      { type: 'notice', level: 'warning', message: 'внимание' },
      { type: 'status', key: 'ext', text: 'работаю' },
      { type: 'status', key: 'ext', text: null },
      { type: 'widget', key: 'w', lines: ['a', 'b'], placement: 'belowEditor' },
      { type: 'widget', key: 'w', lines: null, placement: 'aboveEditor' },
      { type: 'title', title: 'pi - demo' },
      { type: 'editor_text', text: 'заполнено' },
    ]);
  });

  it('пустые/неизвестные события игнорируются', () => {
    const parser = new RpcSessionParser();

    parser.handle({ type: 'message_update' });
    parser.handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } });
    parser.handle({ type: 'unknown' });

    expect(parser.stdout()).toBe('');
    expect(parser.events()).toEqual([]);
  });
});