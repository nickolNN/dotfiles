import { useMemo, type ReactNode } from 'react';
import SessionStatsBar from './SessionStatsBar';
import { useNow } from '../lib/time';
import { analyzeEvents } from './session-view/analyze';
import BashBlock from './session-view/BashBlock';
import { DEFAULT_EMPTY_MESSAGE } from './session-view/constants';
import { workingElapsedMs, workingPhase } from './session-view/phase';
import SessionEventItem from './session-view/SessionEventItem';
import SessionInfoBar from './session-view/SessionInfoBar';
import SessionWidgets from './session-view/SessionWidgets';
import SessionWorking from './session-view/SessionWorking';
import TextBlock from './session-view/TextBlock';
import ThinkingBlock from './session-view/ThinkingBlock';
import { useDocumentTitle } from './session-view/useDocumentTitle';
import type { SessionViewProps } from './session-view/types';
export default function SessionView({
  events,
  stats,
  emptyMessage,
  showFooter = true,
  hideInfo = false,
  infoOnly = false,
  running = false,
  startedAt = null,
  onRecallQueued,
}: SessionViewProps) {
  const {
    visible,
    partialByCallId,
    resultByCallId,
    answersByQuestionId,
    bashText,
    liveThinking,
    liveText,
    info,
  } = useMemo(() => analyzeEvents(events), [events]);

  useDocumentTitle(info.title);

  const now = useNow(running);
  const phase = workingPhase(
    visible,
    resultByCallId,
    liveThinking !== null,
    liveText !== null,
  );
  const elapsedMs = running ? workingElapsedMs(now, startedAt) : null;
  const webChrome = infoOnly || !hideInfo;

  const emptyBody = (
    <div
      data-testid="session-view-empty"
      className="rounded-none border border-dashed border-[#008F11] p-4 text-center text-xs text-[#00FF41]/60"
    >
      {emptyMessage ?? DEFAULT_EMPTY_MESSAGE}
    </div>
  );
  const eventItems = visible.map((event, index) => (
    <SessionEventItem
      key={index}
      event={event}
      partialByCallId={partialByCallId}
      resultByCallId={resultByCallId}
      answersByQuestionId={answersByQuestionId}
      isLast={index === visible.length - 1}
      running={running}
    />
  ));
  let body: ReactNode = visible.length === 0 ? emptyBody : eventItems;
  if (infoOnly) body = null;
  return (
    <div
      data-testid={!infoOnly && visible.length > 0 ? 'session-view' : undefined}
      className="session-view"
    >
      {webChrome && (
        <>
          <SessionInfoBar info={info} onRecallQueued={onRecallQueued} />
          <SessionWidgets
            widgets={info.widgetsAbove}
            placement="aboveEditor"
          />
        </>
      )}
      {body}
      {webChrome && (
        <>
          {running && liveText !== null && (
            <div className="animate-fade-in-up">
              <TextBlock text={liveText} live />
            </div>
          )}
          {running && liveThinking !== null && (
            <ThinkingBlock thinking={liveThinking} streaming />
          )}
          {running && <SessionWorking phase={phase} elapsedMs={elapsedMs} />}
          {bashText !== null && <BashBlock text={bashText} />}
          <SessionWidgets
            widgets={info.widgetsBelow}
            placement="belowEditor"
          />
          {showFooter && <SessionStatsBar events={events} stats={stats} />}
        </>
      )}
    </div>
  );
}