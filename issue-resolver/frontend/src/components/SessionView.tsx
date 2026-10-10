import { useEffect, useMemo, useState } from 'react';
import type { SessionStats } from '@issue-resolver/shared';
import AgentMarkdown from './AgentMarkdown';
import SessionStatsBar from './SessionStatsBar';
import type { SessionEvent } from '../api/session-events';

type QuestionEvent = Extract<SessionEvent, { type: 'question' }>;
type CompactionEvent = Extract<
  SessionEvent,
  { type: 'compaction_start' | 'compaction_end' }
>;
type RetryEvent = Extract<
  SessionEvent,
  { type: 'retry_start' | 'retry_end' }
>;

/** Статус tool-карточки: ждёт запуска / выполняется / есть результат. */
type ToolStatus = 'running' | 'done' | 'waiting';

interface SessionViewProps {
  events: SessionEvent[];
  /** Статистика pi-сессии шага (`get_session_stats`) или null. */
  stats?: SessionStats | null;
  /** Текст пустого состояния. */
  emptyMessage?: string;
  /** Идёт ли работа шага сейчас (живой «работает…» индикатор). */
  running?: boolean;
  /** Начало шага (`created_at`) — для счётчика прошедшего времени. */
  startedAt?: string | null;
  /**
   * Рендерить ли встроенную строку статистики. В модалке выключено — там
   * футер закреплён отдельно, вне скролл-области.
   */
  showFooter?: boolean;
  /**
   * Позволяет «вернуть» текст из очереди steer/follow-up обратно в композер
   * (append, не перезапись черновика). Без коллбэка кнопки ↩ не рендерятся.
   */
  onRecallQueued?: (text: string) => void;
}

/** Виджет расширения: строки над/под логом (placement). */
interface SessionWidget {
  key: string;
  lines: string[];
}

/** Служебная «обвязка» сессии: шапка, очередь, статусы, виджеты, заголовок. */
interface SessionChrome {
  sessionName: string | null;
  thinkingLevel: string | null;
  queue: { steering: string[]; followUp: string[] } | null;
  statuses: Array<{ key: string; text: string }>;
  widgetsAbove: SessionWidget[];
  widgetsBelow: SessionWidget[];
  title: string | null;
  editorText: string | null;
}

interface AnalyzedEvents {
  visible: SessionEvent[];
  partialByCallId: Map<string, string>;
  resultByCallId: Map<string, { isError: boolean; durationMs: number | null }>;
  bashText: string | null;
  chrome: SessionChrome;
}

/**
 * Чат-рендер структурированных событий прогона шага:
 * `text` → markdown ассистента, `thinking` → сворачиваемый блок размышления,
 * `tool_use` → сворачиваемые args (с живым `tool_update`-дополнением),
 * `tool_result` → сворачиваемый результат (красный акцент при ошибке).
 *
 * Служебные события прозрачности (`usage`, `stats`, `queue`, `thinking_level`,
 * `session_info`, `status`, `widget`, `title`, `tool_update`, `bash`,
 * `editor_text`) не рисуются «голыми» строками: они собираются в отдельную
 * обвязку (шапка/очередь/статусы/виджеты/футер) или баннеры.
 */
export default function SessionView({
  events,
  stats,
  emptyMessage,
  showFooter = true,
  running = false,
  startedAt = null,
  onRecallQueued,
}: SessionViewProps) {
  const analyzed = useMemo(() => analyzeEvents(events), [events]);
  const { visible, partialByCallId, resultByCallId, bashText, chrome } =
    analyzed;

  useDocumentTitle(chrome.title);

  const now = useNow(running);
  const phase = workingPhase(visible, resultByCallId);
  const elapsedMs = running ? workingElapsedMs(now, startedAt) : null;

  if (visible.length === 0) {
    return (
      <div className="session-view">
        <SessionChromeBar chrome={chrome} onRecallQueued={onRecallQueued} />
        <SessionWidgets widgets={chrome.widgetsAbove} placement="aboveEditor" />
        <div
          data-testid="session-view-empty"
          className="rounded-none border border-dashed border-[#008F11] p-4 text-center text-xs text-[#00FF41]/60"
        >
          {emptyMessage ?? 'Событий сессии пока нет.'}
        </div>
        {running && <SessionWorking phase={phase} elapsedMs={elapsedMs} />}
        {bashText !== null && <BashBlock text={bashText} />}
        <SessionWidgets widgets={chrome.widgetsBelow} placement="belowEditor" />
        {showFooter && <SessionStatsBar events={events} stats={stats} />}
      </div>
    );
  }

  return (
    <div data-testid="session-view" className="session-view">
      <SessionChromeBar chrome={chrome} onRecallQueued={onRecallQueued} />
      <SessionWidgets widgets={chrome.widgetsAbove} placement="aboveEditor" />
      {visible.map((event, index) => (
        // События сессии — упорядоченный лог без стабильных id; индекс здесь
        // допустим, список только дополняется в конец.
        <SessionEventItem
          key={index}
          event={event}
          partialByCallId={partialByCallId}
          resultByCallId={resultByCallId}
          isLast={index === visible.length - 1}
        />
      ))}
      {running && <SessionWorking phase={phase} elapsedMs={elapsedMs} />}
      {bashText !== null && <BashBlock text={bashText} />}
      <SessionWidgets widgets={chrome.widgetsBelow} placement="belowEditor" />
      {showFooter && <SessionStatsBar events={events} stats={stats} />}
    </div>
  );
}

/**
 * Раскладывает поток событий на видимый список и служебную обвязку.
 * `tool_update` не создаёт карточку: его `partialText` мёржится в
 * соответствующий tool-блок по `toolCallId`.
 */
function analyzeEvents(events: SessionEvent[]): AnalyzedEvents {
  const visible: SessionEvent[] = [];
  const partialByCallId = new Map<string, string>();
  const resultByCallId = new Map<
    string,
    { isError: boolean; durationMs: number | null }
  >();
  const bashDeltas: string[] = [];
  const statuses = new Map<string, string>();
  const widgetsAbove = new Map<string, string[]>();
  const widgetsBelow = new Map<string, string[]>();

  let sessionName: string | null = null;
  let thinkingLevel: string | null = null;
  let queue: { steering: string[]; followUp: string[] } | null = null;
  let title: string | null = null;
  let editorText: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'usage':
      case 'stats':
        // Живут только в футере статистики.
        break;
      case 'tool_update':
        partialByCallId.set(event.toolCallId, event.partialText);
        break;
      case 'tool_result':
        // Статус tool-карточки (running → done + длительность).
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
        // null снимает статус по ключу.
        if (event.text === null) {
          statuses.delete(event.key);
        } else {
          statuses.set(event.key, event.text);
        }
        break;
      case 'widget': {
        const target =
          event.placement === 'aboveEditor' ? widgetsAbove : widgetsBelow;
        // null снимает виджет по ключу.
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
      default:
        visible.push(event);
    }
  }

  return {
    visible,
    partialByCallId,
    resultByCallId,
    bashText: bashDeltas.length > 0 ? bashDeltas.join('') : null,
    chrome: {
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

/**
 * Заголовок вкладки из `title`-события. Не трогает `document.title`, пока
 * событие не пришло; на размонтирование возвращает прежний заголовок.
 */
function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** Фаза работы для живого индикатора «работает». */
type WorkingPhase =
  | { kind: 'tool'; toolName: string }
  | { kind: 'thinking' }
  | { kind: 'text' }
  | { kind: 'idle' };

/** Фаза по последнему видимому событию лога. */
function workingPhase(
  visible: SessionEvent[],
  resultByCallId: Map<string, { isError: boolean; durationMs: number | null }>,
): WorkingPhase {
  const last = visible[visible.length - 1];
  if (!last) return { kind: 'idle' };
  if (last.type === 'tool_use' && !resultByCallId.has(last.toolCallId)) {
    return { kind: 'tool', toolName: last.toolName };
  }
  if (last.type === 'thinking') return { kind: 'thinking' };
  if (last.type === 'text') return { kind: 'text' };
  return { kind: 'idle' };
}

function phaseLabel(phase: WorkingPhase): string {
  switch (phase.kind) {
    case 'tool':
      return `выполняет ${phase.toolName}`;
    case 'thinking':
      return 'думает';
    case 'text':
      return 'печатает';
    default:
      return 'работает';
  }
}

/** Прошедшее с начала шага, если известен `startedAt`. */
function workingElapsedMs(now: number, startedAt: string | null): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, now - start);
}

/** Длительность работы: 45с / 3м 12с / 1ч 2м. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${seconds}с`;
  return `${seconds}с`;
}

/** Живой тик раз в секунду, пока идёт работа. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Строка «работает…»: анимированный маркер, фаза по последнему событию и
 * прошедшее время. Стилистически повторяет live-лейбл `session-thinking-live`.
 */
function SessionWorking({
  phase,
  elapsedMs,
}: {
  phase: WorkingPhase;
  elapsedMs: number | null;
}) {
  return (
    <div
      data-testid="session-working"
      data-phase={phase.kind}
      className="flex flex-wrap items-center gap-x-2 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/50"
    >
      <span aria-hidden="true" className="animate-pulse">
        ◐
      </span>
      <span data-testid="session-working-phase">
        {phaseLabel(phase)}
        <span className="animate-pulse">…</span>
      </span>
      {elapsedMs !== null && (
        <span
          data-testid="session-working-elapsed"
          className="text-[#00FF41]/40"
        >
          {formatElapsed(elapsedMs)}
        </span>
      )}
    </div>
  );
}

function SessionEventItem({
  event,
  partialByCallId,
  resultByCallId,
  isLast,
}: {
  event: SessionEvent;
  partialByCallId: Map<string, string>;
  resultByCallId: Map<string, { isError: boolean; durationMs: number | null }>;
  isLast: boolean;
}) {
  switch (event.type) {
    case 'text':
      return (
        <div data-testid="session-text" className="session-msg session-msg--text">
          <AgentMarkdown>{event.text}</AgentMarkdown>
        </div>
      );

    case 'thinking':
      return <ThinkingBlock thinking={event.thinking} streaming={isLast} />;

    case 'question':
      return <QuestionBlock event={event} />;

    case 'tool_use': {
      const result = resultByCallId.get(event.toolCallId);
      const status: ToolStatus = result
        ? 'done'
        : partialByCallId.has(event.toolCallId)
          ? 'running'
          : 'waiting';
      return (
        <ToolUseBlock
          toolName={event.toolName}
          args={event.args}
          partialText={partialByCallId.get(event.toolCallId)}
          status={status}
          durationMs={result?.durationMs ?? null}
          isError={result?.isError ?? false}
        />
      );
    }

    case 'tool_result':
      return (
        <ToolResultBlock
          toolName={event.toolName}
          isError={event.isError}
          durationMs={event.durationMs}
          resultText={event.resultText}
        />
      );

    case 'compaction_start':
    case 'compaction_end':
      return <CompactionBanner event={event} />;

    case 'retry_start':
    case 'retry_end':
      return <RetryNotice event={event} />;

    case 'notice':
      return <NoticeBanner event={event} />;

    case 'extension_error':
      return <ExtensionErrorBanner message={event.message} />;

    default:
      // Служебные события (usage/stats/queue/session_info/status/widget/…)
      // отфильтрованы в обвязку и отдельными строками не рисуются.
      return null;
  }
}

function QuestionBlock({ event }: { event: QuestionEvent }) {
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
      {event.options && event.options.length > 0 && (
        <p
          data-testid="session-question-options"
          className="session-question-options"
        >
          {event.options.join(' / ')}
        </p>
      )}
    </div>
  );
}

function ThinkingBlock({
  thinking,
  streaming = false,
}: {
  thinking: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Свёрнутая строка-превью: во время стрима — хвост, после — первая строка.
  const preview = streaming
    ? thinking.trimEnd().slice(-80)
    : thinking.split('\n')[0].slice(0, 80);

  return (
    <div
      data-testid="session-thinking"
      data-streaming={streaming ? 'true' : 'false'}
      className="session-thinking"
    >
      <CollapsibleHead
        open={open}
        onToggle={() => setOpen((value) => !value)}
        icon="💭"
        toolName="thinking"
        label={open ? '' : preview}
      />
      {open && streaming && (
        <div
          data-testid="session-thinking-live"
          className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/50"
        >
          думает
          <span className="animate-pulse">…</span>
        </div>
      )}
      {open && (
        <pre data-testid="session-thinking-text" className="session-thinking-body">
          {thinking}
        </pre>
      )}
    </div>
  );
}

function ToolUseBlock({
  toolName,
  args,
  partialText,
  status,
  durationMs,
  isError,
}: {
  toolName: string;
  args: unknown;
  partialText?: string;
  status: ToolStatus;
  durationMs: number | null;
  isError: boolean;
}) {
  const [open, setOpen] = useState(false);
  const argsText = useMemo(() => prettyJson(args), [args]);
  const duration = formatDuration(durationMs);

  return (
    <div
      data-testid={`tool-use-${toolName}`}
      data-status={status}
      className={`session-tool session-tool--use${isError ? ' session-tool--error' : ''}`}
    >
      <CollapsibleHead
        open={open}
        onToggle={() => setOpen((value) => !value)}
        icon="⚙"
        toolName={toolName}
        label="arguments"
      />
      <div
        data-testid={`tool-status-${toolName}`}
        data-status={status}
        className="flex items-center gap-2 px-2 pb-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/50"
      >
        <span aria-hidden="true">
          {status === 'done' ? '✓' : status === 'running' ? '◐' : '…'}
        </span>
        <span>
          {status === 'done'
            ? `готово${duration ? ` · ${duration}` : ''}`
            : status === 'running'
              ? 'выполняется'
              : 'ожидание'}
        </span>
        {isError && <span className="text-[#FF0033]">error</span>}
      </div>
      {open && (
        <pre
          data-testid={`tool-use-args-${toolName}`}
          className="session-tool-body"
        >
          {argsText}
        </pre>
      )}
      {partialText !== undefined && (
        <pre
          data-testid={`tool-partial-${toolName}`}
          className="session-tool-body session-tool-partial"
        >
          {partialText}
        </pre>
      )}
    </div>
  );
}

function ToolResultBlock({
  toolName,
  isError,
  durationMs,
  resultText,
}: {
  toolName: string;
  isError: boolean;
  durationMs: number | null;
  resultText: string;
}) {
  const [open, setOpen] = useState(false);
  const duration = formatDuration(durationMs);

  return (
    <div
      data-testid={`tool-result-${toolName}`}
      data-error={isError ? 'true' : 'false'}
      className={`session-tool session-tool--result${isError ? ' session-tool--error' : ''}`}
    >
      <CollapsibleHead
        open={open}
        onToggle={() => setOpen((value) => !value)}
        icon={isError ? '✕' : '✓'}
        toolName={toolName}
        label="result"
        duration={duration || undefined}
        error={isError}
      />
      {open && (
        <pre
          data-testid={`tool-result-text-${toolName}`}
          className="session-tool-body"
        >
          {resultText}
        </pre>
      )}
    </div>
  );
}

/** Шапка/очередь/статусы сессии — собирается из служебных событий. */
function SessionChromeBar({
  chrome,
  onRecallQueued,
}: {
  chrome: SessionChrome;
  onRecallQueued?: (text: string) => void;
}) {
  const hasQueue = chrome.queue !== null;
  if (
    chrome.sessionName === null &&
    chrome.thinkingLevel === null &&
    !hasQueue &&
    chrome.statuses.length === 0
  ) {
    return null;
  }

  const queuedItems: Array<{ kind: 'steer' | 'follow-up'; text: string; index: number }> = [];
  if (chrome.queue) {
    chrome.queue.steering.forEach((text, index) =>
      queuedItems.push({ kind: 'steer', text, index }),
    );
    chrome.queue.followUp.forEach((text, index) =>
      queuedItems.push({ kind: 'follow-up', text, index }),
    );
  }

  return (
    <div
      data-testid="session-chrome"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-[#008F11]/50 bg-[#000200] px-2 py-1 text-[10px] text-[#00FF41]/70"
    >
      {chrome.sessionName !== null && (
        <span data-testid="session-info" className="break-words">
          сессия: <span className="text-[#00FF41]">{chrome.sessionName}</span>
        </span>
      )}
      {chrome.thinkingLevel !== null && (
        <span data-testid="session-thinking-level">
          thinking:{' '}
          <span className="text-[#00B4FF]">{chrome.thinkingLevel}</span>
        </span>
      )}
      {chrome.queue !== null && (
        <span
          data-testid="session-queue"
          title={queueTitle(chrome.queue)}
          className="text-[#FFB000]"
        >
          очередь: steer {chrome.queue.steering.length} · follow-up{' '}
          {chrome.queue.followUp.length}
        </span>
      )}
      {onRecallQueued &&
        queuedItems.map((item) => (
          <button
            key={`${item.kind}-${item.index}`}
            type="button"
            data-testid={`queue-recall-${item.kind}-${item.index}`}
            title={`Вернуть в поле ввода: ${item.text}`}
            onClick={() => onRecallQueued(item.text)}
            className="max-w-[16rem] truncate border border-[#FFB000]/60 px-1 text-[#FFB000] hover:bg-[#FFB000] hover:text-[#0D0208]"
          >
            ↩ {item.text}
          </button>
        ))}
      {chrome.statuses.map((status) => (
        <span
          key={status.key}
          data-testid={`session-status-${status.key}`}
          className="border border-[#008F11] px-1"
        >
          {status.key}: {status.text}
        </span>
      ))}
    </div>
  );
}

function queueTitle(queue: {
  steering: string[];
  followUp: string[];
}): string {
  const parts: string[] = [];
  if (queue.steering.length > 0) {
    parts.push(`steer: ${queue.steering.join(' | ')}`);
  }
  if (queue.followUp.length > 0) {
    parts.push(`follow-up: ${queue.followUp.join(' | ')}`);
  }
  return parts.join('\n');
}

function SessionWidgets({
  widgets,
  placement,
}: {
  widgets: SessionWidget[];
  placement: 'aboveEditor' | 'belowEditor';
}) {
  if (widgets.length === 0) return null;

  return (
    <>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          data-testid={`session-widget-${widget.key}`}
          data-placement={placement}
          className="border border-[#00B4FF]/50 bg-[#001018] px-2 py-1 text-xs text-[#00B4FF]"
        >
          {widget.lines.map((line, index) => (
            <div key={index} className="whitespace-pre-wrap break-words">
              {line}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function BashBlock({ text }: { text: string }) {
  return (
    <div
      data-testid="session-bash"
      className="border border-[#008F11] bg-[#000200]"
    >
      <div className="border-b border-[#008F11]/50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
        bash
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px] text-[#00FF41]/85">
        {text}
      </pre>
    </div>
  );
}

function CompactionBanner({ event }: { event: CompactionEvent }) {
  if (event.type === 'compaction_start') {
    return (
      <div
        data-testid="session-compaction"
        data-state="start"
        className="flex items-center gap-2 border border-[#FFB000]/60 bg-[#1A1000] px-2 py-1 text-xs text-[#FFB000]"
      >
        <span aria-hidden="true" className="animate-pulse">
          ◐
        </span>
        <span>контекст сжимается · {event.reason}</span>
      </div>
    );
  }

  const header =
    event.tokensBefore !== null
      ? `сжато с ${formatTokens(event.tokensBefore)} токенов`
      : `компакция: ${event.reason}`;

  return (
    <div
      data-testid="session-compaction"
      data-state="end"
      className="border border-[#FFB000]/60 bg-[#1A1000] px-2 py-1 text-xs text-[#FFB000]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span>{header}</span>
        {event.aborted && <span>отменена</span>}
        {event.willRetry && <span>повтор</span>}
        {(event.tokensBefore !== null ||
          event.estimatedTokensAfter !== null) && (
          <span className="text-[#FFB000]/80">
            {formatTokens(event.tokensBefore)} →{' '}
            {formatTokens(event.estimatedTokensAfter)}
          </span>
        )}
        {event.errorMessage !== null && (
          <span className="text-[#FF0033]">{event.errorMessage}</span>
        )}
      </div>
      {event.summary !== null && (
        <div
          data-testid="session-compaction-summary"
          className="mt-1 whitespace-pre-wrap break-words text-[#FFB000]/80"
        >
          {event.summary}
        </div>
      )}
    </div>
  );
}

function RetryNotice({ event }: { event: RetryEvent }) {
  const kind = event.kind === 'summarization' ? 'суммаризация' : 'авто';

  if (event.type === 'retry_start') {
    return (
      <div
        data-testid="session-retry"
        data-state="start"
        className="border border-[#00B4FF]/60 bg-[#001018] px-2 py-1 text-xs text-[#00B4FF]"
      >
        ретрай ({kind})
        {event.attempt !== null &&
          event.maxAttempts !== null &&
          ` · попытка ${event.attempt}/${event.maxAttempts}`}
        {event.delayMs !== null && ` · через ${event.delayMs}ms`}
        {event.errorMessage !== null && (
          <span className="ml-2 text-[#FF0033]">{event.errorMessage}</span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="session-retry"
      data-state="end"
      data-success={event.success === null ? 'unknown' : String(event.success)}
      className={`border px-2 py-1 text-xs ${
        event.success === false
          ? 'border-[#FF0033]/60 bg-[#2A0008] text-[#FF0033]'
          : 'border-[#00FF41]/60 bg-[#003B00] text-[#00FF41]'
      }`}
    >
      ретрай ({kind}): {event.success === false ? 'ошибка' : 'успех'}
      {event.finalError !== null && (
        <span className="ml-2">{event.finalError}</span>
      )}
    </div>
  );
}

function NoticeBanner({
  event,
}: {
  event: Extract<SessionEvent, { type: 'notice' }>;
}) {
  const styles: Record<typeof event.level, string> = {
    info: 'border-[#00B4FF]/60 bg-[#001018] text-[#00B4FF]',
    warning: 'border-[#FFB000]/60 bg-[#1A1000] text-[#FFB000]',
    error: 'border-[#FF0033]/60 bg-[#2A0008] text-[#FF0033]',
  };

  return (
    <div
      data-testid="session-notice"
      data-level={event.level}
      className={`border px-2 py-1 text-xs ${styles[event.level]}`}
    >
      {event.message}
    </div>
  );
}

function ExtensionErrorBanner({ message }: { message: string }) {
  return (
    <div
      data-testid="session-extension-error"
      role="alert"
      className="border border-[#FF0033] bg-[#2A0008] px-2 py-1 text-xs text-[#FF0033]"
    >
      Ошибка расширения: {message}
    </div>
  );
}

function CollapsibleHead({
  open,
  onToggle,
  icon,
  toolName,
  label,
  duration,
  error = false,
}: {
  open: boolean;
  onToggle: () => void;
  icon: string;
  toolName: string;
  label?: string;
  duration?: string;
  error?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="session-tool-head"
    >
      <span aria-hidden="true" className="session-tool-caret">
        {open ? '▾' : '▸'}
      </span>
      <span aria-hidden="true" className="session-tool-icon">
        {icon}
      </span>
      <span className="session-tool-name">{toolName}</span>
      {label && <span className="session-tool-label">{label}</span>}
      {error && <span className="session-tool-error-badge">error</span>}
      {duration && <span className="session-tool-duration">{duration}</span>}
    </button>
  );
}

/** Аккуратно печатает args: строку отдаёт как есть, объект — pretty-JSON. */
function prettyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** "45ms" / "1.2s" / "1m 05s" — длительность выполнения инструмента. */
function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.round(totalSec % 60);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Компактный формат токенов для баннера компакции: null → «—». */
function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}