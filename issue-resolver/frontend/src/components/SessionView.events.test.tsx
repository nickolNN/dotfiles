import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionEvent } from '../api/session-events';
import SessionView from './SessionView';

afterEach(() => {
  cleanup();
  document.title = '';
});

describe('SessionView — события полного pi-паритета (Phase A)', () => {
  it('tool_update мёржится в tool_use по toolCallId, отдельной карточки нет', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool_use',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
      },
      {
        type: 'tool_use',
        toolCallId: 'call-2',
        toolName: 'read',
        args: { path: '/tmp/a' },
      },
      {
        type: 'tool_update',
        toolCallId: 'call-2',
        toolName: 'read',
        partialText: 'частичный вывод чтения',
      },
    ];
    render(<SessionView events={events} />);

    expect(screen.getByTestId('tool-use-bash')).toBeInTheDocument();
    expect(screen.getByTestId('tool-use-read')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-partial-bash')).toBeNull();
    expect(screen.getByTestId('tool-partial-read')).toHaveTextContent(
      'частичный вывод чтения',
    );
  });

  it('compaction_start/end → инлайн-баннер с summary и токенами', () => {
    const events: SessionEvent[] = [
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        summary: 'сжали историю',
        aborted: false,
        willRetry: false,
        errorMessage: null,
        tokensBefore: 120_000,
        estimatedTokensAfter: 40_000,
      },
    ];
    render(<SessionView events={events} />);

    const banners = screen.getAllByTestId('session-compaction');
    expect(banners).toHaveLength(2);
    expect(banners[0]).toHaveAttribute('data-state', 'start');
    expect(banners[0]).toHaveTextContent('threshold');
    expect(banners[1]).toHaveAttribute('data-state', 'end');
    expect(screen.getByTestId('session-compaction-summary')).toHaveTextContent(
      'сжали историю',
    );
    expect(banners[1]).toHaveTextContent('120.0k');
    expect(banners[1]).toHaveTextContent('40.0k');
  });

  it('compaction_end: aborted/errorMessage отражаются в баннере', () => {
    render(
      <SessionView
        events={[
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
        ]}
      />,
    );

    const banner = screen.getByTestId('session-compaction');
    expect(banner).toHaveTextContent('отменена');
    expect(banner).toHaveTextContent('boom');
  });

  it('retry_start/end → инлайн-уведомление с попыткой и итогом', () => {
    const events: SessionEvent[] = [
      {
        type: 'retry_start',
        kind: 'auto',
        attempt: 2,
        maxAttempts: 5,
        delayMs: 1500,
        errorMessage: 'rate limited',
        source: null,
        reason: null,
      },
      {
        type: 'retry_end',
        kind: 'auto',
        success: false,
        attempt: 2,
        finalError: 'gave up',
      },
    ];
    render(<SessionView events={events} />);

    const notices = screen.getAllByTestId('session-retry');
    expect(notices).toHaveLength(2);
    expect(notices[0]).toHaveAttribute('data-state', 'start');
    expect(notices[0]).toHaveTextContent('попытка 2/5');
    expect(notices[0]).toHaveTextContent('1500ms');
    expect(notices[0]).toHaveTextContent('rate limited');
    expect(notices[1]).toHaveAttribute('data-success', 'false');
    expect(notices[1]).toHaveTextContent('gave up');
  });

  it('queue → чип с количеством и текстами в title', () => {
    render(
      <SessionView
        events={[
          { type: 'queue', steering: ['стоп', 'ещё'], followUp: ['потом'] },
        ]}
      />,
    );

    const chip = screen.getByTestId('session-queue');
    expect(chip).toHaveTextContent('steer 2');
    expect(chip).toHaveTextContent('follow-up 1');
    expect(chip).toHaveAttribute('title', expect.stringContaining('стоп | ещё'));
    expect(chip).toHaveAttribute('title', expect.stringContaining('потом'));
  });

  it('thinking_level и session_info → чипы шапки', () => {
    render(
      <SessionView
        events={[
          { type: 'session_info', name: 'Resolve #1' },
          { type: 'thinking_level', level: 'high' },
        ]}
      />,
    );

    expect(screen.getByTestId('session-info')).toHaveTextContent('Resolve #1');
    expect(screen.getByTestId('session-thinking-level')).toHaveTextContent(
      'high',
    );
  });

  it('notice → баннер с цветом по level', () => {
    render(
      <SessionView
        events={[
          { type: 'notice', level: 'warning', message: 'осторожно' },
          { type: 'notice', level: 'error', message: 'плохо' },
        ]}
      />,
    );

    const notices = screen.getAllByTestId('session-notice');
    expect(notices[0]).toHaveAttribute('data-level', 'warning');
    expect(notices[1]).toHaveAttribute('data-level', 'error');
    expect(notices[1]).toHaveTextContent('плохо');
  });

  it('status: строка по key, null снимает статус', () => {
    const { rerender } = render(
      <SessionView
        events={[
          { type: 'status', key: 'lint', text: 'running' },
          { type: 'status', key: 'docs', text: 'done' },
        ]}
      />,
    );

    expect(screen.getByTestId('session-status-lint')).toHaveTextContent('lint');
    expect(screen.getByTestId('session-status-docs')).toHaveTextContent('docs');

    rerender(
      <SessionView
        events={[
          { type: 'status', key: 'lint', text: 'running' },
          { type: 'status', key: 'lint', text: null },
        ]}
      />,
    );

    expect(screen.queryByTestId('session-status-lint')).toBeNull();
  });

  it('widget → блок с placement above/below', () => {
    render(
      <SessionView
        events={[
          { type: 'widget', key: 'a', lines: ['верх'], placement: 'aboveEditor' },
          { type: 'widget', key: 'b', lines: ['низ'], placement: 'belowEditor' },
          { type: 'text', text: 'тело' },
        ]}
      />,
    );

    expect(screen.getByTestId('session-widget-a')).toHaveAttribute(
      'data-placement',
      'aboveEditor',
    );
    expect(screen.getByTestId('session-widget-b')).toHaveAttribute(
      'data-placement',
      'belowEditor',
    );
    expect(screen.getByTestId('session-widget-b')).toHaveTextContent('низ');
  });

  it('title → document.title', () => {
    render(<SessionView events={[{ type: 'title', title: 'pi: Resolve' }]} />);

    expect(document.title).toBe('pi: Resolve');
  });

  it('extension_error → error-баннер', () => {
    render(
      <SessionView
        events={[{ type: 'extension_error', message: 'extension crashed' }]}
      />,
    );

    const banner = screen.getByTestId('session-extension-error');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('extension crashed');
  });

  it('bash: дельты складываются в один блок вывода', () => {
    const events: SessionEvent[] = [
      { type: 'bash', delta: 'line-1\n' },
      { type: 'bash', delta: 'line-2\n' },
    ];
    render(<SessionView events={events} />);

    const block = screen.getByTestId('session-bash');
    expect(block).toHaveTextContent('line-1');
    expect(block).toHaveTextContent('line-2');
    expect(screen.queryByTestId('session-view')).toBeNull();
  });

  it('editor_text фильтруется из лога (не голубая строка)', () => {
    render(
      <SessionView
        events={[
          { type: 'text', text: 'видимый текст' },
          { type: 'editor_text', text: 'префилл для инпута' },
        ]}
      />,
    );

    expect(screen.getAllByTestId('session-text')).toHaveLength(1);
    expect(screen.queryByText('префилл для инпута')).toBeNull();
  });

  it('обвязка не ломается на пустом списке (chrome + заглушка)', () => {
    render(<SessionView events={[{ type: 'thinking_level', level: 'low' }]} />);

    expect(
      within(screen.getByTestId('session-info')).getByTestId(
        'session-thinking-level',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('session-view-empty')).toBeInTheDocument();
  });

  it('tool_use status: waiting → running → done с длительностью', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool_use',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'ls' },
      },
      {
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: false,
        durationMs: 42,
        resultText: 'ok',
      },
      { type: 'tool_use', toolCallId: 'c2', toolName: 'read', args: {} },
      {
        type: 'tool_update',
        toolCallId: 'c2',
        toolName: 'read',
        partialText: 'partial',
      },
      { type: 'tool_use', toolCallId: 'c3', toolName: 'grep', args: {} },
    ];
    render(<SessionView events={events} />);

    expect(screen.getByTestId('tool-status-bash')).toHaveAttribute(
      'data-status',
      'done',
    );
    expect(screen.getByTestId('tool-status-bash')).toHaveTextContent('42ms');
    expect(screen.getByTestId('tool-status-read')).toHaveAttribute(
      'data-status',
      'running',
    );
    expect(screen.getByTestId('tool-status-grep')).toHaveAttribute(
      'data-status',
      'waiting',
    );
  });

  it('thinking: последний блок помечен streaming и показывает live-лейбл', () => {
    render(
      <SessionView
        running
        events={[{ type: 'thinking', thinking: 'первая\nвторая' }]}
      />,
    );

    const block = screen.getByTestId('session-thinking');
    expect(block).toHaveAttribute('data-streaming', 'true');
    fireEvent.click(within(block).getByRole('button'));
    expect(screen.getByTestId('session-thinking-live')).toBeInTheDocument();
  });

  it('thinking: не последний блок — не streaming', () => {
    render(
      <SessionView
        events={[
          { type: 'thinking', thinking: 'размышление' },
          { type: 'text', text: 'ответ' },
        ]}
      />,
    );

    expect(screen.getByTestId('session-thinking')).toHaveAttribute(
      'data-streaming',
      'false',
    );
  });

  it('compaction: live-баннер «контекст сжимается», итог «сжато с N токенов»', () => {
    const { rerender } = render(
      <SessionView
        events={[{ type: 'compaction_start', reason: 'manual' }]}
      />,
    );
    expect(screen.getByTestId('session-compaction')).toHaveTextContent(
      'контекст сжимается',
    );
    expect(screen.getByTestId('session-compaction')).toHaveTextContent('manual');

    rerender(
      <SessionView
        events={[
          {
            type: 'compaction_end',
            reason: 'manual',
            summary: 'итог',
            aborted: false,
            willRetry: false,
            errorMessage: null,
            tokensBefore: 5000,
            estimatedTokensAfter: 1200,
          },
        ]}
      />,
    );
    expect(screen.getByTestId('session-compaction')).toHaveTextContent(
      'сжато с',
    );
  });

  it('queue recall: кнопка возвращает текст через onRecallQueued', () => {
    const recalled: string[] = [];
    render(
      <SessionView
        events={[{ type: 'queue', steering: ['верни меня'], followUp: [] }]}
        onRecallQueued={(text) => recalled.push(text)}
      />,
    );

    fireEvent.click(screen.getByTestId('queue-recall-steer-0'));
    expect(recalled).toEqual(['верни меня']);
  });

  it('queue recall: без коллбэка кнопок возврата нет', () => {
    render(
      <SessionView
        events={[{ type: 'queue', steering: ['верни меня'], followUp: [] }]}
      />,
    );

    expect(screen.queryByTestId('queue-recall-steer-0')).toBeNull();
  });
});

describe('SessionView — индикатор «работает» (running)', () => {
  it('running=false → индикатора нет', () => {
    render(<SessionView events={[{ type: 'thinking', thinking: 'x' }]} />);
    expect(screen.queryByTestId('session-working')).toBeNull();
  });

  it('running без событий → «работает…»', () => {
    render(<SessionView running events={[]} />);
    expect(screen.getByTestId('session-view-empty')).toBeInTheDocument();
    const row = screen.getByTestId('session-working');
    expect(row).toHaveAttribute('data-phase', 'idle');
    expect(row).toHaveTextContent('работает…');
  });

  it('running + последнее thinking → «думает…»', () => {
    render(
      <SessionView
        running
        events={[{ type: 'thinking', thinking: 'размышляю' }]}
      />,
    );
    const row = screen.getByTestId('session-working');
    expect(row).toHaveAttribute('data-phase', 'thinking');
    expect(row).toHaveTextContent('думает…');
  });

  it('running + незавершённый tool_use → «выполняет <tool>…»', () => {
    render(
      <SessionView
        running
        events={[
          {
            type: 'tool_use',
            toolCallId: 'call-1',
            toolName: 'bash',
            args: { command: 'ls' },
          },
        ]}
      />,
    );
    const row = screen.getByTestId('session-working');
    expect(row).toHaveAttribute('data-phase', 'tool');
    expect(row).toHaveTextContent('выполняет bash…');
  });

  it('running + последний tool_use уже с результатом → «работает…»', () => {
    render(
      <SessionView
        running
        events={[
          {
            type: 'tool_use',
            toolCallId: 'call-1',
            toolName: 'bash',
            args: {},
          },
          {
            type: 'tool_result',
            toolCallId: 'call-1',
            toolName: 'bash',
            isError: false,
            durationMs: 5,
            resultText: 'ok',
          },
        ]}
      />,
    );
    const row = screen.getByTestId('session-working');
    expect(row).toHaveAttribute('data-phase', 'idle');
    expect(row).toHaveTextContent('работает…');
  });

  it('running + последнее text → «печатает…»', () => {
    render(
      <SessionView running events={[{ type: 'text', text: 'ответ' }]} />,
    );
    const row = screen.getByTestId('session-working');
    expect(row).toHaveAttribute('data-phase', 'text');
    expect(row).toHaveTextContent('печатает…');
  });

  it('running + startedAt → показывает прошедшее время', () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    render(
      <SessionView
        running
        startedAt={startedAt}
        events={[{ type: 'thinking', thinking: 'x' }]}
      />,
    );
    expect(screen.getByTestId('session-working-elapsed')).toHaveTextContent(
      /1м \d+с/,
    );
  });

  it('несколько thinking подряд: отдельные блоки, streaming только у последнего', () => {
    render(
      <SessionView
        running
        events={[
          { type: 'thinking', thinking: 'первый' },
          { type: 'thinking', thinking: 'второй' },
          { type: 'thinking', thinking: 'третий' },
        ]}
      />,
    );
    const blocks = screen.getAllByTestId('session-thinking');
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.getAttribute('data-streaming'))).toEqual([
      'false',
      'false',
      'true',
    ]);
  });
});

describe('SessionView — живое размышление (thinking_update)', () => {
  it('running: update\u2019ы дают один live-блок с последним partial \u2014 без дубля', () => {
    render(
      <SessionView
        running
        events={[
          { type: 'thinking_update', contentIndex: 0, partialText: 'первая' },
          {
            type: 'thinking_update',
            contentIndex: 0,
            partialText: 'первая и вторая',
          },
        ]}
      />,
    );

    const blocks = screen.getAllByTestId('session-thinking');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveAttribute('data-streaming', 'true');
    expect(screen.getByTestId('session-thinking-text')).toHaveTextContent(
      'первая и вторая',
    );
    expect(screen.getByTestId('session-thinking-live')).toBeInTheDocument();
  });

  it('running: live-блок ограничен по высоте и скроллится внутри себя', () => {
    render(
      <SessionView
        running
        events={[
          { type: 'thinking_update', contentIndex: 0, partialText: 'мысль' },
        ]}
      />,
    );

    const body = screen.getByTestId('session-thinking-text');
    expect(body.className).toContain('max-h-96');
    expect(body.className).toContain('overflow-auto');
  });

  it('running: живой partial делает фазу «думает» поверх предыдущего text', () => {
    render(
      <SessionView
        running
        events={[
          { type: 'text', text: 'вступление' },
          {
            type: 'thinking_update',
            contentIndex: 0,
            partialText: 'размышляю',
          },
        ]}
      />,
    );

    expect(screen.getByTestId('session-working')).toHaveAttribute(
      'data-phase',
      'thinking',
    );
    expect(screen.getByTestId('session-thinking-text')).toHaveTextContent(
      'размышляю',
    );
  });

  it('финальный thinking ретирит live-partial \u2014 остаётся один финальный блок', () => {
    const { rerender } = render(
      <SessionView
        running
        events={[
          { type: 'thinking_update', contentIndex: 0, partialText: 'partial' },
        ]}
      />,
    );
    expect(screen.getAllByTestId('session-thinking')).toHaveLength(1);
    expect(screen.getByTestId('session-thinking-text')).toHaveTextContent(
      'partial',
    );

    rerender(
      <SessionView
        running
        events={[
          { type: 'thinking_update', contentIndex: 0, partialText: 'partial' },
          { type: 'thinking', thinking: 'финальный текст' },
        ]}
      />,
    );

    const blocks = screen.getAllByTestId('session-thinking');
    expect(blocks).toHaveLength(1);
    expect(screen.getByTestId('session-thinking-text')).toHaveTextContent(
      'финальный текст',
    );
    expect(screen.queryByText('partial')).toBeNull();
  });

  it('не-running (персистентная) сессия: thinking_update не рисует live-блок', () => {
    render(
      <SessionView
        events={[
          { type: 'thinking_update', contentIndex: 0, partialText: 'partial' },
        ]}
      />,
    );

    expect(screen.queryByTestId('session-thinking')).toBeNull();
  });

  it('persisted thinking без update\u2019ов рендерится как обычный блок', () => {
    render(
      <SessionView events={[{ type: 'thinking', thinking: 'размышление' }]} />,
    );

    const block = screen.getByTestId('session-thinking');
    expect(block).toHaveAttribute('data-streaming', 'false');
    fireEvent.click(within(block).getByRole('button'));
    expect(screen.getByTestId('session-thinking-text')).toHaveTextContent(
      'размышление',
    );
  });
});
describe('SessionView — живая проза (text_update)', () => {
  it('running: update\u2019ы дают один live-блок с последним partial \u2014 не по блоку на чанк', () => {
    render(
      <SessionView
        running
        events={[
          { type: 'text_update', contentIndex: 0, partialText: 'One' },
          { type: 'text_update', contentIndex: 0, partialText: 'One bug in ' },
          {
            type: 'text_update',
            contentIndex: 0,
            partialText: 'One bug in the restore section',
          },
        ]}
      />,
    );

    const blocks = screen.getAllByTestId('session-text-live');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveTextContent('One bug in the restore section');
    expect(screen.queryAllByTestId('session-text')).toHaveLength(0);
    expect(screen.getByTestId('session-working')).toHaveAttribute(
      'data-phase',
      'text',
    );
  });

  it('финальный text ретирит live-прогу \u2014 остаётся один финальный блок', () => {
    const { rerender } = render(
      <SessionView
        running
        events={[
          { type: 'text_update', contentIndex: 0, partialText: 'partial' },
        ]}
      />,
    );
    expect(screen.getAllByTestId('session-text-live')).toHaveLength(1);

    rerender(
      <SessionView
        running
        events={[
          { type: 'text_update', contentIndex: 0, partialText: 'partial' },
          { type: 'text', text: 'финальный текст' },
        ]}
      />,
    );

    expect(screen.queryByTestId('session-text-live')).toBeNull();
    expect(screen.getAllByTestId('session-text')).toHaveLength(1);
    expect(screen.getByTestId('session-text')).toHaveTextContent(
      'финальный текст',
    );
  });

  it('не-running (персистентная) сессия: text_update не рисует live-блок', () => {
    render(
      <SessionView
        events={[
          { type: 'text_update', contentIndex: 0, partialText: 'partial' },
        ]}
      />,
    );

    expect(screen.queryByTestId('session-text-live')).toBeNull();
    expect(screen.queryAllByTestId('session-text')).toHaveLength(0);
  });
});
