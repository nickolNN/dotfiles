import type { AnswerModelEvent } from './types';

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export function answerModelText(event: AnswerModelEvent): string | null {
  const model = nonEmpty(event.responseModel) ?? nonEmpty(event.model);
  const requested = nonEmpty(event.thinkingLevel);
  const effort = nonEmpty(event.providerThinkingLevel) ?? requested;

  const parts: string[] = [];
  if (model !== null) parts.push(`модель ${model}`);
  if (effort !== null) {
    const requestedSuffix =
      requested !== null && requested !== effort
        ? ` (запрошено ${requested})`
        : '';
    parts.push(`усилие ${effort}${requestedSuffix}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

export default function AnswerModelLine({ event }: { event: AnswerModelEvent }) {
  const text = answerModelText(event);
  if (text === null) return null;
  return (
    <div
      data-testid="session-answer-model"
      className="border border-[#00B4FF]/60 bg-[#001018] px-2 py-1 text-xs text-[#00B4FF]"
    >
      {text}
    </div>
  );
}