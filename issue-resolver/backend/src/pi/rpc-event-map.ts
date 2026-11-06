import { SessionNoticeLevel, numberOrNull } from '@issue-resolver/shared';
import type { SessionEvent, SessionQuestion } from '@issue-resolver/shared';
import { asRecord } from '../util/records';
import { stringArray, stringOrNull } from '../util/scalars';
import {
  compactionReason,
  errorEventMessage,
  isDialogMethod,
  toolResultText,
  type RpcEvent,
} from './rpc-events';
import { noticeEvent } from './agent-session';

function dialogEvent(
  event: RpcEvent,
  method: SessionQuestion['method'],
  id: string,
): SessionEvent {
  return {
    type: 'question',
    id,
    method,
    title: typeof event.title === 'string' ? event.title : '',
    ...(typeof event.message === 'string' ? { message: event.message } : {}),
    ...(Array.isArray(event.options)
      ? {
          options: event.options.filter(
            (option): option is string => typeof option === 'string',
          ),
        }
      : {}),
    ...(typeof event.placeholder === 'string'
      ? { placeholder: event.placeholder }
      : {}),
    ...(typeof event.prefill === 'string' ? { prefill: event.prefill } : {}),
  };
}

export function mapUiRequest(event: RpcEvent): SessionEvent | null {
  if (event.type !== 'extension_ui_request' || typeof event.method !== 'string') {
    return null;
  }

  const method = event.method;
  if (typeof event.id === 'string' && isDialogMethod(method)) {
    return dialogEvent(event, method, event.id);
  }

  switch (event.method) {
    case 'notify': {
      const level =
        event.notifyType === SessionNoticeLevel.warning ||
        event.notifyType === SessionNoticeLevel.error
          ? event.notifyType
          : SessionNoticeLevel.info;
      return noticeEvent(
        level,
        typeof event.message === 'string' ? event.message : '',
      );
    }
    case 'setStatus':
      return {
        type: 'status',
        key: typeof event.statusKey === 'string' ? event.statusKey : '',
        text: stringOrNull(event.statusText),
      };
    case 'setWidget': {
      const lines = event.widgetLines;
      return {
        type: 'widget',
        key: typeof event.widgetKey === 'string' ? event.widgetKey : '',
        lines:
          Array.isArray(lines) && lines.every((line) => typeof line === 'string')
            ? (lines as string[])
            : null,
        placement:
          event.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor',
      };
    }
    case 'setTitle':
      return {
        type: 'title',
        title: typeof event.title === 'string' ? event.title : '',
      };
    case 'set_editor_text':
      return {
        type: 'editor_text',
        text: typeof event.text === 'string' ? event.text : '',
      };
    default:
      return null;
  }
}

export function mapStatelessEvent(event: RpcEvent): SessionEvent | null {
  if (event.type === 'tool_execution_start') {
    return {
      type: 'tool_use',
      toolCallId: String(event.toolCallId ?? ''),
      toolName: String(event.toolName ?? ''),
      args: event.args ?? null,
    };
  }

  if (event.type === 'tool_execution_end') {
    return {
      type: 'tool_result',
      toolCallId: String(event.toolCallId ?? ''),
      toolName: String(event.toolName ?? ''),
      isError: event.isError === true,
      durationMs:
        typeof event.durationMs === 'number' ? event.durationMs : null,
      resultText: toolResultText(event.result),
    };
  }

  if (event.type === 'tool_execution_update') {
    return {
      type: 'tool_update',
      toolCallId: String(event.toolCallId ?? ''),
      toolName: String(event.toolName ?? ''),
      partialText: toolResultText(event.partialResult),
    };
  }

  if (event.type === 'compaction_start') {
    return {
      type: 'compaction_start',
      reason: compactionReason(event.reason),
    };
  }

  if (event.type === 'compaction_end') {
    const result = asRecord(event.result);
    return {
      type: 'compaction_end',
      reason: compactionReason(event.reason),
      summary: stringOrNull(result?.summary),
      aborted: event.aborted === true,
      willRetry: event.willRetry === true,
      errorMessage: stringOrNull(event.errorMessage),
      tokensBefore: numberOrNull(result?.tokensBefore),
      estimatedTokensAfter: numberOrNull(result?.estimatedTokensAfter),
    };
  }

  if (event.type === 'auto_retry_start') {
    return {
      type: 'retry_start',
      kind: 'auto',
      attempt: numberOrNull(event.attempt),
      maxAttempts: numberOrNull(event.maxAttempts),
      delayMs: numberOrNull(event.delayMs),
      errorMessage: stringOrNull(event.errorMessage),
      source: null,
      reason: null,
    };
  }

  if (event.type === 'auto_retry_end') {
    return {
      type: 'retry_end',
      kind: 'auto',
      success: typeof event.success === 'boolean' ? event.success : null,
      attempt: numberOrNull(event.attempt),
      finalError: stringOrNull(event.finalError),
    };
  }

  if (event.type === 'summarization_retry_scheduled') {
    return {
      type: 'retry_start',
      kind: 'summarization',
      attempt: numberOrNull(event.attempt),
      maxAttempts: numberOrNull(event.maxAttempts),
      delayMs: numberOrNull(event.delayMs),
      errorMessage: stringOrNull(event.errorMessage),
      source: null,
      reason: null,
    };
  }

  if (event.type === 'summarization_retry_finished') {
    return {
      type: 'retry_end',
      kind: 'summarization',
      success: null,
      attempt: null,
      finalError: null,
    };
  }

  if (event.type === 'queue_update') {
    return {
      type: 'queue',
      steering: stringArray(event.steering),
      followUp: stringArray(event.followUp),
    };
  }

  if (event.type === 'thinking_level_changed') {
    return {
      type: 'thinking_level',
      level: typeof event.level === 'string' ? event.level : '',
    };
  }

  if (event.type === 'session_info_changed') {
    return {
      type: 'session_info',
      name: stringOrNull(event.name),
    };
  }

  if (event.type === 'extension_error') {
    return { type: 'extension_error', message: String(event.error) };
  }

  if (event.type === 'error') {
    return noticeEvent(SessionNoticeLevel.error, errorEventMessage(event));
  }

  if (event.type === 'bash_execution_update') {
    return {
      type: 'bash',
      delta: typeof event.delta === 'string' ? event.delta : '',
    };
  }

  return null;
}