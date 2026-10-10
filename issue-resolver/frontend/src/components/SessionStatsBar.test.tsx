import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { SessionStats } from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';
import SessionStatsBar from './SessionStatsBar';

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    userMessages: 1,
    assistantMessages: 2,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 6,
    tokens: {
      input: 100_000,
      output: 5_000,
      cacheRead: 0,
      cacheWrite: 0,
      total: 105_000,
    },
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

describe('SessionStatsBar', () => {
  it('рендерит строку «CTX · ↑ · ↓ · кеш» из prop stats', () => {
    render(<SessionStatsBar events={[]} stats={makeStats()} />);

    const bar = screen.getByTestId('session-stats');
    expect(bar).toHaveTextContent('CTX 21%');
    expect(tokenIn(bar)).toHaveTextContent('100k');
    expect(tokenOut(bar)).toHaveTextContent('5k');
    expect(bar).toHaveTextContent('кеш 0');
    expect(bar).not.toHaveTextContent('$');
  });

  it('input/output — inline-SVG стрелки ↑/↓ с currentColor', () => {
    render(<SessionStatsBar events={[]} stats={makeStats()} />);

    const bar = screen.getByTestId('session-stats');
    for (const token of [tokenIn(bar), tokenOut(bar)]) {
      const svg = token.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).toHaveAttribute('stroke', 'currentColor');
    }
  });

  it('живое usage-событие без stats даёт строку с отправлено/получено/кеш', () => {
    render(<SessionStatsBar events={[usageEvent(1500, 0.0021)]} />);

    const bar = screen.getByTestId('session-stats');
    expect(tokenIn(bar)).toHaveTextContent('1.5k');
    expect(tokenOut(bar)).toHaveTextContent('0');
    expect(bar).toHaveTextContent('кеш 0');
    expect(bar).not.toHaveTextContent('CTX');
    expect(bar).not.toHaveTextContent('$');
  });

  it('кеш = cacheRead + cacheWrite', () => {
    render(
      <SessionStatsBar
        events={[]}
        stats={makeStats({
          tokens: {
            input: 10_000,
            output: 1_000,
            cacheRead: 2_000,
            cacheWrite: 1_000,
            total: 14_000,
          },
        })}
      />,
    );

    const bar = screen.getByTestId('session-stats');
    expect(tokenIn(bar)).toHaveTextContent('10k');
    expect(tokenOut(bar)).toHaveTextContent('1k');
    expect(bar).toHaveTextContent('кеш 3k');
  });

  it('без данных не рендерит строку', () => {
    render(<SessionStatsBar events={[{ type: 'text', text: 'готово' }]} />);

    expect(screen.queryByTestId('session-stats')).toBeNull();
  });

  it('model: показывает модель перед «CTX»', () => {
    render(
      <SessionStatsBar
        events={[]}
        stats={makeStats({ model: 'Claude Sonnet 4' })}
      />,
    );

    const bar = screen.getByTestId('session-stats');
    expect(bar).toHaveTextContent('Claude Sonnet 4');
    expect(bar).toHaveTextContent('CTX 21%');
    expect(bar.textContent!.indexOf('Claude Sonnet 4')).toBeLessThan(
      bar.textContent!.indexOf('CTX'),
    );
  });

  it('model без contextUsage: «{model} · ↑ · ↓ · кеш» без «CTX»', () => {
    render(
      <SessionStatsBar
        events={[]}
        stats={makeStats({ model: 'Claude Sonnet 4', contextUsage: null })}
      />,
    );

    const bar = screen.getByTestId('session-stats');
    expect(bar).toHaveTextContent('Claude Sonnet 4');
    expect(bar).not.toHaveTextContent('CTX');
    expect(tokenIn(bar)).toHaveTextContent('100k');
    expect(tokenOut(bar)).toHaveTextContent('5k');
    expect(bar).toHaveTextContent('кеш 0');
  });

  it('без model не показывает метку модели (формат неизменён)', () => {
    render(<SessionStatsBar events={[]} stats={makeStats()} />);

    const bar = screen.getByTestId('session-stats');
    expect(bar).not.toHaveTextContent('Claude Sonnet 4');
    expect(bar).toHaveTextContent('CTX 21%');
    expect(tokenIn(bar)).toHaveTextContent('100k');
  });

  it('прокидывает className обёртке', () => {
    render(
      <SessionStatsBar
        events={[]}
        stats={makeStats()}
        className="pinned-footer"
      />,
    );

    expect(screen.getByTestId('session-stats')).toHaveClass(
      'session-stats',
      'pinned-footer',
    );
  });
});