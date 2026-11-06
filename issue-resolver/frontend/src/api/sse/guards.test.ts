import { describe, expect, it } from 'vitest';
import { isSessionEvent, parseSessionEvent } from './guards';

const ANSWER_EVENT: Record<string, unknown> = {
  type: 'answer_model',
  model: 'claude-sonnet-4-5',
  responseModel: 'claude-sonnet-4-5',
  thinkingLevel: 'high',
  providerThinkingLevel: 'medium',
};

describe('sse/guards — answer_model', () => {
  it('принимает строки и null в каждом из четырёх полей', () => {
    expect(isSessionEvent(ANSWER_EVENT)).toBe(true);

    const allNull: Record<string, unknown> = {
      type: 'answer_model',
      model: null,
      responseModel: null,
      thinkingLevel: null,
      providerThinkingLevel: null,
    };
    expect(isSessionEvent(allNull)).toBe(true);
    expect(parseSessionEvent(allNull)).toEqual(allNull);
  });

  it('отклоняет событие с отсутствующим полем', () => {
    const { thinkingLevel: omittedLevel, ...withoutLevel } = ANSWER_EVENT;
    expect(omittedLevel).toBe('high');
    expect(isSessionEvent(withoutLevel)).toBe(false);
    expect(parseSessionEvent(withoutLevel)).toBeNull();
  });

  it('отклоняет нестроковое значение, в том числе вместо null', () => {
    expect(isSessionEvent({ ...ANSWER_EVENT, model: 42 })).toBe(false);
    expect(
      isSessionEvent({ ...ANSWER_EVENT, providerThinkingLevel: false }),
    ).toBe(false);
  });
});