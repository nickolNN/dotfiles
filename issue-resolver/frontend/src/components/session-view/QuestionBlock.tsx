import { Fragment } from 'react';
import type { QuestionEvent } from './types';

function optionClass(
  selected: string | null,
  option: string,
): string | undefined {
  if (selected === null) return undefined;
  return option === selected ? 'font-bold text-[#00FF41]' : 'text-[#00FF41]/40';
}

export default function QuestionBlock({
  event,
  answer,
}: {
  event: QuestionEvent;
  answer?: string;
}) {
  const options = event.options ?? [];
  const selected =
    answer !== undefined && options.includes(answer) ? answer : null;

  return (
    <div data-testid="session-question" className="session-question">
      <div className="session-question-head">
        <span aria-hidden="true" className="session-question-icon">
          ?
        </span>
        <span className="session-question-kind">вопрос</span>
        <span className="session-question-method">{event.method}</span>
      </div>
      <p data-testid="session-question-title" className="session-question-title">
        {event.title}
      </p>
      {event.message && (
        <p className="session-question-message">{event.message}</p>
      )}
      {options.length > 0 && (
        <p
          data-testid="session-question-options"
          className="session-question-options"
        >
          {options.map((option, index) => (
            <Fragment key={`${index}-${option}`}>
              {index > 0 && ' / '}
              <span
                data-testid="session-question-option"
                data-selected={
                  selected === null ? 'false' : String(option === selected)
                }
                className={optionClass(selected, option)}
              >
                {option}
              </span>
            </Fragment>
          ))}
        </p>
      )}
      {answer !== undefined && (
        <p
          data-testid="session-question-answer"
          className="session-question-answer mt-1 font-bold text-[#00FF41]"
        >
          Ответ: {answer}
        </p>
      )}
    </div>
  );
}