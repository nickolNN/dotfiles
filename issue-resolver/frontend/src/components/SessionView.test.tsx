import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionStats } from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';
import SessionView from './SessionView';

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    userMessages: 1,
    assistantMessages: 2,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 6,
    tokens: { input: 100_000, output: 5_000, cacheRead: 0, cacheWrite: 0, total: 105_000 },
    cost: 0.0123,
    contextUsage: { tokens: 42_000, contextWindow: 200_000, percent: 21 },
    ...overrides,
  };
}

function usageEvent(total: number, costTotal: number | null): SessionEvent {
  return {
    type: 'usage',
    usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
    cost:
      costTotal === null
        ? null
        : {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: costTotal,
          },
  };
}

/** Обёртка input-токенов со стрелкой ↑ внутри `session-stats`. */
function tokenIn(bar: HTMLElement): HTMLElement {
  return within(bar).getByTestId('session-token-in');
}

/** Обёртка output-токенов со стрелкой ↓ внутри `session-stats`. */
function tokenOut(bar: HTMLElement): HTMLElement {
  return within(bar).getByTestId('session-token-out');
}

afterEach(() => {
  cleanup();
});

describe('SessionView — чат структурированных событий', () => {
  it('пустой список показывает заглушку', () => {
    render(<SessionView events={[]} />);

    expect(screen.getByTestId('session-view-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('session-view')).toBeNull();
  });

  it('text-событие рендерится как markdown ассистента', () => {
    render(
      <SessionView
        events={[{ type: 'text', text: 'обычный **жирный** текст' }]}
      />,
    );

    const text = screen.getByTestId('session-text');
    expect(within(text).getByText('жирный').tagName).toBe('STRONG');
    expect(within(text).getByText(/обычный/)).toBeInTheDocument();
  });

  it('tool_use: свёрнут по умолчанию, клик по заголовку раскрывает pretty-JSON args', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool_use',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls -la', cwd: '/tmp' },
      },
    ];
    render(<SessionView events={events} />);

    const block = screen.getByTestId('tool-use-bash');
    expect(within(block).getByText('bash')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-use-args-bash')).toBeNull();

    fireEvent.click(within(block).getByRole('button'));

    const args = screen.getByTestId('tool-use-args-bash');
    expect(args).toHaveTextContent('"command": "ls -la"');
    expect(args).toHaveTextContent('"cwd": "/tmp"');
  });

  it('tool_result: свёрнут, клик раскрывает resultText, успех без красного акцента', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: false,
        durationMs: 12,
        resultText: 'file-a\nfile-b',
      },
    ];
    render(<SessionView events={events} />);

    const block = screen.getByTestId('tool-result-bash');
    expect(block).toHaveAttribute('data-error', 'false');
    expect(block.className).not.toContain('session-tool--error');
    expect(screen.queryByTestId('tool-result-text-bash')).toBeNull();

    fireEvent.click(within(block).getByRole('button'));

    expect(screen.getByTestId('tool-result-text-bash')).toHaveTextContent(
      'file-a',
    );
    expect(within(block).getByText('12ms')).toBeInTheDocument();
  });

  it('tool_result: при isError — красный акцент и бейдж error', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool_result',
        toolCallId: 'call-2',
        toolName: 'read',
        isError: true,
        durationMs: null,
        resultText: 'ENOENT: no such file',
      },
    ];
    render(<SessionView events={events} />);

    const block = screen.getByTestId('tool-result-read');
    expect(block).toHaveAttribute('data-error', 'true');
    expect(block.className).toContain('session-tool--error');
    expect(within(block).getByText('error')).toBeInTheDocument();

    fireEvent.click(within(block).getByRole('button'));
    expect(screen.getByTestId('tool-result-text-read')).toHaveTextContent(
      'ENOENT: no such file',
    );
  });

  it('thinking: свёрнут по умолчанию, клик раскрывает текст размышления', () => {
    const events: SessionEvent[] = [
      { type: 'thinking', thinking: 'надо проверить кэш' },
    ];
    render(<SessionView events={events} />);

    const block = screen.getByTestId('session-thinking');
    expect(within(block).getByText('thinking')).toBeInTheDocument();
    // Свёрнутая шапка: «thinking» + превью, без дублирующего «reasoning».
    expect(block).toHaveTextContent('надо проверить кэш');
    expect(block).not.toHaveTextContent('reasoning');
    expect(screen.queryByTestId('session-thinking-text')).toBeNull();

    fireEvent.click(within(block).getByRole('button'));

    expect(screen.getByTestId('session-thinking-text')).toHaveTextContent(
      'надо проверить кэш',
    );
    expect(block).not.toHaveTextContent('reasoning');
  });

  it('question: рендерится блок «вопрос» с title/method/options, не роняя список', () => {
    const events: SessionEvent[] = [
      { type: 'text', text: 'перед вопросом' },
      {
        type: 'question',
        id: 'q-1',
        method: 'select',
        title: 'Какой подход выбрать?',
        message: 'Нужно уточнение',
        options: ['вариант-a', 'вариант-b'],
      },
    ];
    render(<SessionView events={events} />);

    // Обычное text-событие рядом продолжает рендериться.
    expect(screen.getByTestId('session-text')).toHaveTextContent(
      'перед вопросом',
    );

    const block = screen.getByTestId('session-question');
    expect(
      within(block).getByTestId('session-question-title'),
    ).toHaveTextContent('Какой подход выбрать?');
    expect(within(block).getByText('select')).toBeInTheDocument();
    expect(within(block).getByText('Нужно уточнение')).toBeInTheDocument();
    expect(
      within(block).getByTestId('session-question-options'),
    ).toHaveTextContent('вариант-a / вариант-b');
  });

  it('stats: футер не рендерится при stats = null', () => {
    render(
      <SessionView
        events={[{ type: 'text', text: 'готово' }]}
        stats={null}
      />,
    );

    expect(screen.queryByTestId('session-stats')).toBeNull();
  });

  it('showFooter=false скрывает встроенный футер', () => {
    render(
      <SessionView
        events={[{ type: 'text', text: 'готово' }]}
        stats={makeStats()}
        showFooter={false}
      />,
    );

    expect(screen.getByTestId('session-text')).toBeInTheDocument();
    expect(screen.queryByTestId('session-stats')).toBeNull();
  });

  it('stats: футер показывает контекст и разбивку токенов', () => {
    render(
      <SessionView
        events={[{ type: 'text', text: 'готово' }]}
        stats={makeStats()}
      />,
    );

    const footer = screen.getByTestId('session-stats');
    expect(footer).toHaveTextContent('CTX 21%');
    expect(tokenIn(footer)).toHaveTextContent('100k');
    expect(tokenOut(footer)).toHaveTextContent('5k');
    expect(footer).toHaveTextContent('кеш 0');
    expect(footer).not.toHaveTextContent('$');
  });

  it('stats: футер показывает модель перед «Контекст»', () => {
    render(
      <SessionView
        events={[{ type: 'text', text: 'готово' }]}
        stats={makeStats({ model: 'Claude Sonnet 4' })}
      />,
    );

    const footer = screen.getByTestId('session-stats');
    expect(footer).toHaveTextContent('Claude Sonnet 4');
    expect(footer).toHaveTextContent('CTX 21%');
    expect(footer.textContent!.indexOf('Claude Sonnet 4')).toBeLessThan(
      footer.textContent!.indexOf('CTX'),
    );
  });

  it('stats: модель без contextUsage — без «Контекст»', () => {
    render(
      <SessionView
        events={[{ type: 'text', text: 'готово' }]}
        stats={makeStats({ model: 'Claude Sonnet 4', contextUsage: null })}
      />,
    );

    const footer = screen.getByTestId('session-stats');
    expect(footer).toHaveTextContent('Claude Sonnet 4');
    expect(footer).not.toHaveTextContent('CTX');
    expect(tokenIn(footer)).toHaveTextContent('100k');
    expect(tokenOut(footer)).toHaveTextContent('5k');
    expect(footer).toHaveTextContent('кеш 0');
  });

  it('usage + stats: модель берётся из stats, токены — из живого usage', () => {
    render(
      <SessionView
        events={[usageEvent(1200, 0.5)]}
        stats={makeStats({ model: 'Claude Sonnet 4' })}
      />,
    );

    const footer = screen.getByTestId('session-stats');
    expect(footer).toHaveTextContent('Claude Sonnet 4');
    expect(footer).toHaveTextContent('CTX 21%');
    expect(tokenIn(footer)).toHaveTextContent('1.2k');
  });

  it('stats: без contextUsage показывает только отправлено/получено/кеш', () => {
    render(
      <SessionView
        events={[{ type: 'text', text: 'готово' }]}
        stats={makeStats({
          tokens: { input: 900, output: 50, cacheRead: 0, cacheWrite: 0, total: 950 },
          cost: null,
          contextUsage: null,
        })}
      />,
    );

    const footer = screen.getByTestId('session-stats');
    expect(footer).not.toHaveTextContent('CTX');
    expect(tokenIn(footer)).toHaveTextContent('900');
    expect(tokenOut(footer)).toHaveTextContent('50');
    expect(footer).toHaveTextContent('кеш 0');
  });

  it('usage: живой футер с разбивкой токенов без stats', () => {
    render(
      <SessionView
        events={[{ type: 'text', text: 'работаю' }, usageEvent(1500, 0.0021)]}
      />,
    );

    const footer = screen.getByTestId('session-stats');
    expect(tokenIn(footer)).toHaveTextContent('1.5k');
    expect(tokenOut(footer)).toHaveTextContent('0');
    expect(footer).toHaveTextContent('кеш 0');
    expect(footer).not.toHaveTextContent('CTX');
  });

  it('usage: живой футер виден даже при пустом списке событий', () => {
    render(<SessionView events={[usageEvent(1500, 0.0021)]} />);

    expect(screen.getByTestId('session-view-empty')).toBeInTheDocument();
    expect(tokenIn(screen.getByTestId('session-stats'))).toHaveTextContent(
      '1.5k',
    );
  });

  it('usage: cost null не влияет на строку', () => {
    render(<SessionView events={[usageEvent(500, null)]} />);

    const footer = screen.getByTestId('session-stats');
    expect(tokenIn(footer)).toHaveTextContent('500');
    expect(tokenOut(footer)).toHaveTextContent('0');
    expect(footer).toHaveTextContent('кеш 0');
    expect(footer).not.toHaveTextContent('$');
  });

  it('usage + stats: токены из живого, контекст% из stats', () => {
    render(
      <SessionView
        events={[usageEvent(1200, 0.5)]}
        stats={makeStats()}
      />,
    );

    const footer = screen.getByTestId('session-stats');
    expect(footer).toHaveTextContent('CTX 21%');
    expect(tokenIn(footer)).toHaveTextContent('1.2k');
    expect(tokenOut(footer)).toHaveTextContent('0');
    expect(footer).toHaveTextContent('кеш 0');
  });

  it('stats-событие: живой футер из события, в списке не рендерится', () => {
    const events: SessionEvent[] = [
      { type: 'text', text: 'работаю' },
      {
        type: 'stats',
        stats: makeStats({
          tokens: {
            input: 30_000,
            output: 1_000,
            cacheRead: 0,
            cacheWrite: 0,
            total: 31_000,
          },
          cost: 0.05,
          contextUsage: { tokens: 31_000, contextWindow: 200_000, percent: 16 },
        }),
      },
    ];
    render(<SessionView events={events} />);

    const footer = screen.getByTestId('session-stats');
    expect(footer).toHaveTextContent('CTX 16%');
    expect(tokenIn(footer)).toHaveTextContent('30k');
    expect(tokenOut(footer)).toHaveTextContent('1k');
    expect(footer).toHaveTextContent('кеш 0');
    // stats-событие идёт только в футер — плашкой в списке не рисуется.
    expect(screen.getAllByTestId('session-text')).toHaveLength(1);
  });

  it('stats-событие приоритетнее prop stats', () => {
    render(
      <SessionView
        events={[
          {
            type: 'stats',
            stats: makeStats({
              tokens: {
                input: 30_000,
                output: 1_000,
                cacheRead: 0,
                cacheWrite: 0,
                total: 31_000,
              },
              cost: 0.05,
              contextUsage: null,
            }),
          },
        ]}
        stats={makeStats()}
      />,
    );

    const footer = screen.getByTestId('session-stats');
    expect(tokenIn(footer)).toHaveTextContent('30k');
    expect(tokenOut(footer)).toHaveTextContent('1k');
    expect(footer).not.toHaveTextContent('CTX');
  });

  it('stats-событие: выигрывает последнее из нескольких', () => {
    const events: SessionEvent[] = [
      {
        type: 'stats',
        stats: makeStats({
          tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 },
          cost: 0.01,
          contextUsage: null,
        }),
      },
      {
        type: 'stats',
        stats: makeStats({
          tokens: { input: 900, output: 0, cacheRead: 0, cacheWrite: 0, total: 900 },
          cost: 0.02,
          contextUsage: null,
        }),
      },
    ];
    render(<SessionView events={events} />);

    const footer = screen.getByTestId('session-stats');
    expect(tokenIn(footer)).toHaveTextContent('900');
    expect(tokenOut(footer)).toHaveTextContent('0');
    expect(footer).toHaveTextContent('кеш 0');
  });
});