import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AnswerModelLine from './AnswerModelLine';
import type { AnswerModelEvent } from './types';

function answerEvent(
  overrides: Partial<AnswerModelEvent> = {},
): AnswerModelEvent {
  return {
    type: 'answer_model',
    model: 'claude-sonnet-4-5',
    responseModel: 'claude-sonnet-4-5',
    thinkingLevel: 'high',
    providerThinkingLevel: 'high',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('AnswerModelLine', () => {
  it('печатает модель и усилие без повтора, когда уровни совпали', () => {
    render(<AnswerModelLine event={answerEvent()} />);

    const line = screen.getByTestId('session-answer-model');
    expect(line).toHaveTextContent('модель claude-sonnet-4-5 · усилие high');
    expect(line).not.toHaveTextContent('запрошено');
  });

  it('предпочитает ответившую модель и провайдерское усилие, запрошенное — в скобках', () => {
    render(
      <AnswerModelLine
        event={answerEvent({
          model: 'claude-sonnet-4-5',
          responseModel: 'claude-opus-4-1',
          thinkingLevel: 'high',
          providerThinkingLevel: 'medium',
        })}
      />,
    );

    expect(screen.getByTestId('session-answer-model')).toHaveTextContent(
      'модель claude-opus-4-1 · усилие medium (запрошено high)',
    );
  });

  it('молчит, когда все четыре поля null', () => {
    render(
      <AnswerModelLine
        event={answerEvent({
          model: null,
          responseModel: null,
          thinkingLevel: null,
          providerThinkingLevel: null,
        })}
      />,
    );

    expect(screen.queryByTestId('session-answer-model')).toBeNull();
  });

  it('считает пустые строки отсутствующими', () => {
    render(
      <AnswerModelLine
        event={answerEvent({
          model: '',
          responseModel: '  ',
          thinkingLevel: '',
          providerThinkingLevel: '',
        })}
      />,
    );

    expect(screen.queryByTestId('session-answer-model')).toBeNull();
  });

  it('печатает только модель, когда уровень усилия неизвестен', () => {
    render(
      <AnswerModelLine
        event={answerEvent({ thinkingLevel: null, providerThinkingLevel: null })}
      />,
    );

    expect(screen.getByTestId('session-answer-model')).toHaveTextContent(
      'модель claude-sonnet-4-5',
    );
    expect(screen.getByTestId('session-answer-model')).not.toHaveTextContent(
      'усилие',
    );
  });
});