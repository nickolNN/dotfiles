import type { ReactNode } from 'react';
import type { SessionEvent } from '../../api/session-events';
import CompactionBanner from './CompactionBanner';
import ExtensionErrorBanner from './ExtensionErrorBanner';
import NoticeBanner from './NoticeBanner';
import QuestionBlock from './QuestionBlock';
import RetryNotice from './RetryNotice';
import TextBlock from './TextBlock';
import ThinkingBlock from './ThinkingBlock';
import ToolResultBlock from './ToolResultBlock';
import ToolUseBlock from './ToolUseBlock';
import { ToolStatus, type EventMaps } from './types';

function toolStatus(
  toolCallId: string,
  maps: EventMaps,
): ToolStatus {
  if (maps.resultByCallId.has(toolCallId)) return ToolStatus.done;
  if (maps.partialByCallId.has(toolCallId)) return ToolStatus.running;
  return ToolStatus.waiting;
}

export default function SessionEventItem({
  event,
  partialByCallId,
  resultByCallId,
  answersByQuestionId,
  isLast,
  running = false,
}: {
  event: SessionEvent;
  partialByCallId: Map<string, string>;
  resultByCallId: EventMaps['resultByCallId'];
  answersByQuestionId: Map<string, string>;
  isLast: boolean;
  running?: boolean;
}) {
  const streaming = isLast && running;
  const maps: EventMaps = {
    partialByCallId,
    resultByCallId,
    answersByQuestionId,
  };

  let content: ReactNode = null;
  switch (event.type) {
    case 'text':
      content = <TextBlock text={event.text} />;
      break;

    case 'thinking':
      content = (
        <ThinkingBlock thinking={event.thinking} streaming={streaming} />
      );
      break;

    case 'question':
      content = (
        <QuestionBlock
          event={event}
          answer={answersByQuestionId.get(event.id)}
        />
      );
      break;

    case 'tool_use': {
      const result = resultByCallId.get(event.toolCallId);
      content = (
        <ToolUseBlock
          toolName={event.toolName}
          args={event.args}
          partialText={partialByCallId.get(event.toolCallId)}
          status={toolStatus(event.toolCallId, maps)}
          durationMs={result?.durationMs ?? null}
          isError={result?.isError ?? false}
        />
      );
      break;
    }

    case 'tool_result':
      content = (
        <ToolResultBlock
          toolName={event.toolName}
          isError={event.isError}
          durationMs={event.durationMs}
          resultText={event.resultText}
        />
      );
      break;

    case 'compaction_start':
    case 'compaction_end':
      content = <CompactionBanner event={event} />;
      break;

    case 'retry_start':
    case 'retry_end':
      content = <RetryNotice event={event} />;
      break;

    case 'notice':
      content = <NoticeBanner event={event} />;
      break;

    case 'extension_error':
      content = <ExtensionErrorBanner message={event.message} />;
      break;
  }

  return content === null ? null : (
    <div className="animate-fade-in-up">{content}</div>
  );
}