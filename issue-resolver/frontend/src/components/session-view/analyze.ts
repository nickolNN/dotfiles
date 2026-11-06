import type { SessionEvent } from '../../api/session-events';
import type { AnalyzedEvents, SessionInfo, ToolResultInfo } from './types';

export function analyzeEvents(events: SessionEvent[]): AnalyzedEvents {
  const visible: SessionEvent[] = [];
  const partialByCallId = new Map<string, string>();
  const resultByCallId = new Map<string, ToolResultInfo>();
  const answersByQuestionId = new Map<string, string>();
  const bashDeltas: string[] = [];
  const statuses = new Map<string, string>();
  const widgetsAbove = new Map<string, string[]>();
  const widgetsBelow = new Map<string, string[]>();

  let sessionName: string | null = null;
  let thinkingLevel: string | null = null;
  let queue: SessionInfo['queue'] = null;
  let title: string | null = null;
  let editorText: string | null = null;
  let liveThinking: string | null = null;
  let liveText: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'usage':
      case 'stats':
        break;
      case 'question_answered':
        answersByQuestionId.set(event.questionId, event.answer);
        break;
      case 'tool_update':
        partialByCallId.set(event.toolCallId, event.partialText);
        break;
      case 'tool_result':
        resultByCallId.set(event.toolCallId, {
          isError: event.isError,
          durationMs: event.durationMs,
        });
        visible.push(event);
        break;
      case 'bash':
        bashDeltas.push(event.delta);
        break;
      case 'session_info':
        sessionName = event.name;
        break;
      case 'thinking_level':
        thinkingLevel = event.level;
        break;
      case 'queue':
        queue = {
          steering: [...event.steering],
          followUp: [...event.followUp],
        };
        break;
      case 'status':
        if (event.text === null) {
          statuses.delete(event.key);
        } else {
          statuses.set(event.key, event.text);
        }
        break;
      case 'widget': {
        const target =
          event.placement === 'aboveEditor' ? widgetsAbove : widgetsBelow;
        if (event.lines === null) {
          target.delete(event.key);
        } else {
          target.set(event.key, event.lines);
        }
        break;
      }
      case 'title':
        title = event.title;
        break;
      case 'editor_text':
        editorText = event.text;
        break;
      case 'thinking_update':
        liveThinking = event.partialText;
        break;
      case 'text_update':
        liveText = event.partialText;
        break;
      case 'text':
        visible.push(event);
        liveText = null;
        break;
      case 'thinking':
        visible.push(event);
        liveThinking = null;
        break;
      default:
        visible.push(event);
    }
  }

  return {
    visible,
    partialByCallId,
    resultByCallId,
    answersByQuestionId,
    bashText: bashDeltas.length > 0 ? bashDeltas.join('') : null,
    liveThinking,
    liveText,
    info: {
      sessionName,
      thinkingLevel,
      queue,
      statuses: Array.from(statuses, ([key, text]) => ({ key, text })),
      widgetsAbove: Array.from(widgetsAbove, ([key, lines]) => ({ key, lines })),
      widgetsBelow: Array.from(widgetsBelow, ([key, lines]) => ({ key, lines })),
      title,
      editorText,
    },
  };
}