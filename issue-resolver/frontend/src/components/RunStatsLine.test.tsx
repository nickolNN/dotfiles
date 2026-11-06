import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import RunStatsLine from './RunStatsLine';
import type { FooterData } from './SessionStatsBar';

afterEach(() => {
  cleanup();
});

const footer: FooterData = {
  model: 'model-x',
  percent: 12,
  input: 1000,
  output: 2000,
  cached: 3000,
  tokensPerSecond: 4.25,
  avgTokensPerSecond: 3.6,
  toolCalls: 3,
};

describe('RunStatsLine', () => {
  it('печатает вызовы и обе скорости внутри группы токенов', () => {
    render(
      <RunStatsLine prefix="step" duration="1м 5с" cost={0.5} footer={footer} />,
    );

    const tokens = screen.getByTestId('step-tokens');
    expect(tokens).toHaveTextContent('3 вызовов');

    const speed = within(tokens).getByTestId('step-speed');
    expect(speed).toHaveTextContent('4.3 t/s');
    expect(speed).toHaveTextContent('avg 4 t/s');
  });

  it('children идут после токенов и держат строку, когда больше нечего показать', () => {
    render(
      <RunStatsLine prefix="step" duration="" cost={null} footer={null}>
        <span data-testid="step-files">Файлы не изменялись</span>
      </RunStatsLine>,
    );

    const stats = screen.getByTestId('step-stats');
    expect(within(stats).getByTestId('step-files')).toBeInTheDocument();
    expect(within(stats).queryByTestId('step-tokens')).toBeNull();
  });

  it('costEstimate помечает cost как оценку, по умолчанию маркера нет', () => {
    render(
      <RunStatsLine
        prefix="step"
        duration=""
        cost={0.5}
        costEstimate
        footer={null}
      />,
    );
    expect(screen.getByTestId('step-cost')).toHaveTextContent('≈$0.5');

    cleanup();

    render(
      <RunStatsLine prefix="step" duration="" cost={0.5} footer={null} />,
    );
    expect(screen.getByTestId('step-cost')).toHaveTextContent('$0.5');
    expect(screen.getByTestId('step-cost')).not.toHaveTextContent('≈');
  });

  it('без данных не рендерит строку', () => {
    const { container } = render(
      <RunStatsLine prefix="step" duration="" cost={null} footer={null} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});